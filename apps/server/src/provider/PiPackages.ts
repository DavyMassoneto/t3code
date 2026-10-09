import {
  PiPackageError,
  PiPackageListResult,
  PiPackageMutationInput,
  PiPackageSource,
  PiPackageSearchInput,
  PiPackageSearchResult,
  PiSettings,
  type PiPackageTarget,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { resolveNativePiAgentDirectory } from "./nativePiAgentDirectory.ts";
import { PI_PACKAGE_NATIVE_SOURCE } from "./piPackageNativeSource.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as Stream from "effect/Stream";

const CATALOG_URL = "https://pi.dev/packages";
const packageTypes = ["extension", "skill", "theme", "prompt"] as const;
const decodeSearchInput = Schema.decodeEffect(PiPackageSearchInput);
const validSearchResult = Schema.is(PiPackageSearchResult);
const decodeListJson = Schema.decodeUnknownSync(Schema.fromJsonString(PiPackageListResult));
const decodeSource = Schema.decodeUnknownSync(PiPackageSource);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const TrustStore = Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Null]));

function decodeHtml(value: string): string {
  return value.replace(
    /&#(x[0-9a-f]+|\d+);|&(amp|quot|apos|lt|gt);/gi,
    (_, numeric: string | undefined, named: string | undefined) => {
      if (numeric) {
        const point = numeric.startsWith("x")
          ? Number.parseInt(numeric.slice(1), 16)
          : Number(numeric);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      }
      return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[named?.toLowerCase() ?? ""] ?? "";
    },
  );
}

function catalogText(value: string): string {
  const text = decodeHtml(
    value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, ""),
  );
  return Array.from(text)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function catalogInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,16}$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function catalogPagination(html: string, catalogUrl: string): PiPackageSearchResult["pagination"] {
  const count = html.match(/<[^>]+class="[^"]*\bpackages-count\b[^"]*"[^>]*>([\s\S]*?)<\//)?.[1];
  const range =
    count === undefined
      ? undefined
      : catalogText(count).match(/^(?:(\d+)\s*-\s*(\d+)|(0))\s*\/\s*(\d+)(?:\s*\(of\s+(\d+)\))?$/);
  if (!range) return undefined;
  const start = catalogInteger(range[1]),
    end = catalogInteger(range[2]);
  const denominator = catalogInteger(range[4]),
    catalogTotal = catalogInteger(range[5] ?? range[4]);
  const total = range[3] === "0" ? 0 : denominator;
  if (
    total === undefined ||
    catalogTotal === undefined ||
    total > catalogTotal ||
    (start !== undefined &&
      (end === undefined || start > end || end > total || (total > 0 && start < 1)))
  )
    return undefined;
  const navigation = html.match(
    /<nav\b[^>]*class="[^"]*\bpackages-pagination\b[^"]*"[^>]*>([\s\S]*?)<\/nav>/,
  )?.[1];
  let request: URL;
  try {
    request = new URL(catalogUrl);
  } catch {
    return undefined;
  }
  if (
    request.origin !== "https://pi.dev" ||
    request.pathname !== "/packages" ||
    request.username ||
    request.password
  )
    return undefined;
  const active = navigation?.match(/<[^>]+aria-current="page"[^>]*>\s*(\d+)\s*</)?.[1];
  const page = catalogInteger(active ?? request.searchParams.get("page") ?? "1") ?? 0;
  if (page < 1 || page > 1000000) return undefined;
  let hasNext = false,
    hasPrevious = false;
  const advertised: number[] = [];
  for (const anchor of (navigation ?? "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = anchor[1]?.match(/\bhref="([^"]*)"/)?.[1];
    const classes = anchor[1]?.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    if (!href) continue;
    let target: URL;
    try {
      target = new URL(decodeHtml(href), CATALOG_URL);
    } catch {
      continue;
    }
    if (
      target.origin !== request.origin ||
      target.pathname !== "/packages" ||
      target.username ||
      target.password ||
      target.hash ||
      Array.from(target.searchParams.keys()).some(
        (key) =>
          !["name", "type", "sort", "page"].includes(key) ||
          target.searchParams.getAll(key).length !== 1,
      )
    )
      continue;
    if (
      ["name", "type", "sort"].some(
        (key) =>
          (target.searchParams.get(key) ?? (key === "sort" ? "downloads" : "")) !==
          (request.searchParams.get(key) ?? (key === "sort" ? "downloads" : "")),
      )
    )
      continue;
    const targetPage = catalogInteger(target.searchParams.get("page") ?? "1");
    if (targetPage === undefined || targetPage < 1 || targetPage > 1000000) continue;
    const label = catalogText(anchor[2] ?? "");
    if (classes.includes("pagination-link") && label.includes("Next") && targetPage === page + 1)
      hasNext = true;
    if (
      classes.includes("pagination-link") &&
      label.includes("Previous") &&
      targetPage === page - 1
    )
      hasPrevious = true;
    if (classes.includes("pagination-page") && catalogInteger(label) === targetPage)
      advertised.push(targetPage);
  }
  const totalPages = advertised.length ? Math.max(page, ...advertised) : undefined;
  return {
    page,
    total,
    catalogTotal,
    ...(start !== undefined && end !== undefined ? { rangeStart: start, rangeEnd: end } : {}),
    ...(totalPages !== undefined ? { totalPages } : {}),
    hasNext: total > 0 && hasNext,
    hasPrevious: total > 0 && hasPrevious,
  };
}

export function parsePiPackageCatalog(html: string, catalogUrl: string): PiPackageSearchResult {
  const packages: PiPackageSearchResult["packages"][number][] = [];
  for (const card of html.matchAll(
    /<article\b[^>]*data-package-card="true"[^>]*>[\s\S]*?<\/article>/g,
  )) {
    const name = decodeHtml(card[0].match(/data-package-name="([^"]+)"/)?.[1] ?? "");
    const source = decodeHtml(card[0].match(/data-copy-text="pi install ([^"]+)"/)?.[1] ?? "");
    if (!name || !source || source !== `npm:${name}` || !Schema.is(PiPackageSource)(source))
      continue;
    const description = decodeHtml(
      (card[0].match(/<p class="packages-desc">([\s\S]*?)<\/p>/)?.[1] ?? "").replace(
        /<[^>]*>/g,
        "",
      ),
    );
    const rawTypes = card[0].match(/data-package-types="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    const href = decodeHtml(card[0].match(/href="([^"]+)"\s+data-package-link="true"/)?.[1] ?? "");
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, CATALOG_URL);
    } catch {
      continue;
    }
    if (
      url.origin !== "https://pi.dev" ||
      url.username ||
      url.password ||
      !url.pathname.startsWith("/packages/")
    )
      continue;
    const authorText = card[0].match(
      /<div\b[^>]*class="[^"]*\bpackages-meta\b[^"]*"[^>]*>\s*<span\b[^>]*>([\s\S]*?)<\/span>/,
    )?.[1];
    const author = authorText === undefined ? undefined : catalogText(authorText);
    const monthlyDownloads = catalogInteger(card[0].match(/data-package-downloads="([^"]*)"/)?.[1]);
    const date = catalogInteger(card[0].match(/data-package-date="([^"]*)"/)?.[1]);
    const publicationDate =
      date !== undefined && date <= 8640000000000000 ? DateTime.make(date) : Option.none();
    const publishedAt = Option.isSome(publicationDate)
      ? DateTime.formatIso(publicationDate.value)
      : undefined;
    packages.push({
      name,
      description,
      source,
      url: url.href,
      types: packageTypes.filter((type) => rawTypes.includes(type)),
      ...(author && author.length <= 256 ? { author } : {}),
      ...(monthlyDownloads !== undefined ? { monthlyDownloads } : {}),
      ...(publishedAt && /^\d{4}-\d{2}-\d{2}T/.test(publishedAt) ? { publishedAt } : {}),
    });
  }
  if (
    packages.length === 0 &&
    !html.includes('class="packages-action-bar"') &&
    !html.includes("packages-action-bar")
  ) {
    throw new Error("The official Pi gallery returned an unrecognized response.");
  }
  const pagination = catalogPagination(html, catalogUrl);
  const result = { packages, catalogUrl, ...(pagination ? { pagination } : {}) };
  if (!validSearchResult(result))
    throw new Error("The official Pi gallery returned invalid metadata.");
  return result;
}

export class PiPackages extends Context.Service<
  PiPackages,
  {
    readonly search: (
      input: PiPackageSearchInput,
    ) => Effect.Effect<PiPackageSearchResult, PiPackageError>;
    readonly list: (input: PiPackageTarget) => Effect.Effect<PiPackageListResult, PiPackageError>;
    readonly mutate: (
      input: PiPackageMutationInput,
    ) => Effect.Effect<PiPackageListResult, PiPackageError>;
  }
>()("t3/provider/PiPackages") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const config = yield* ServerConfig.ServerConfig;
  const executable = yield* SpawnExecutableResolution;
  const platform = yield* HostProcessPlatform;
  const lock = yield* KeyedLock.make<string>();
  const error = (message: string) => new PiPackageError({ message });
  const readJson = Effect.fnUntraced(function* (filename: string) {
    const exists = yield* fs.exists(filename);
    if (!exists) return {};
    const contents = yield* fs.readFileString(filename);
    return yield* Effect.try({
      try: () => decodeJson(contents.replace(/^\uFEFF/u, "")),
      catch: () => error("Invalid Pi configuration. Repair it in Pi before managing packages."),
    });
  });
  const resolve = Effect.fnUntraced(function* (input: PiPackageTarget) {
    if (input.scope === "project" && !input.projectId)
      return yield* error("Select a project for project-scoped packages.");
    if (input.scope === "global" && input.projectId)
      return yield* error("Global packages must not include a project target.");
    const current = yield* settings.getSettings;
    const instance = current.providerInstances[input.instanceId];
    if ((instance && instance.driver !== "pi") || (!instance && input.instanceId !== "pi"))
      return yield* error("Select a configured Pi instance.");
    const pi = yield* Schema.decodeUnknownEffect(PiSettings)(
      instance?.config ?? current.providers.pi,
    );
    const env = { ...mergeProviderInstanceEnvironment(instance?.environment) };
    const expandedAgentDir = yield* Effect.try({
      try: () =>
        resolveNativePiAgentDirectory({
          environment: env,
          platform,
          fallbackHome: expandHomePathWith("~", path),
          path,
        }),
      catch: () =>
        error(
          "Relative PI_CODING_AGENT_DIR or instance home is ambiguous across projects. Configure an absolute path or a ~/ path with an absolute instance home before managing packages.",
        ),
    });
    const agentDir = yield* fs
      .realPath(expandedAgentDir)
      .pipe(Effect.orElseSucceed(() => path.normalize(expandedAgentDir)));
    env.PI_CODING_AGENT_DIR = agentDir;
    let cwd = config.cwd;
    if (input.scope === "project" && input.projectId) {
      const project = yield* projects.getById(input.projectId);
      if (Option.isNone(project)) return yield* error("Project not found in this environment.");
      cwd = yield* fs.realPath(project.value.workspaceRoot);
      const trust = yield* readJson(path.join(agentDir, "trust.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(TrustStore)),
      );
      let decision: boolean | undefined;
      let ancestor = cwd;
      while (true) {
        if (
          typeof trust === "object" &&
          trust !== null &&
          !Array.isArray(trust) &&
          ancestor in trust
        ) {
          const value: unknown = Reflect.get(trust, ancestor);
          if (typeof value === "boolean") {
            decision = value;
            break;
          }
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      if (decision !== true)
        return yield* error(
          "Project packages require saved Pi project trust. Trust this workspace in Pi before managing its packages.",
        );
    }
    const binary = executable(expandHomePathWith(pi.binaryPath || "pi", path), platform, env);
    if (!binary) return yield* error("The selected Pi executable could not be found.");
    const realBinary = yield* fs.realPath(binary);
    let directory = path.dirname(realBinary);
    let sdkRoot: string | undefined;
    for (let depth = 0; depth < 6 && sdkRoot === undefined; depth += 1) {
      for (const candidate of [
        directory,
        path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent"),
        path.join(directory, "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
      ]) {
        if (yield* fs.exists(path.join(candidate, "dist", "core", "package-manager.js"))) {
          sdkRoot = candidate;
          break;
        }
      }
      directory = path.dirname(directory);
    }
    if (!sdkRoot)
      return yield* error(
        "This Pi installation does not expose its native package SDK. Use an npm Pi installation to manage packages here.",
      );
    return {
      sdkRoot,
      agentDir,
      cwd,
      env,
      scope: input.scope,
      scopeLabel:
        input.scope === "global"
          ? `Global Pi packages · ${agentDir}`
          : `Project Pi packages · ${cwd}`,
    };
  });
  const runNative = Effect.fnUntraced(
    function* (
      target: Effect.Success<ReturnType<typeof resolve>>,
      mutation?: PiPackageMutationInput,
    ) {
      const payload = encodeJson({
        sdkRoot: target.sdkRoot,
        cwd: target.cwd,
        agentDir: target.agentDir,
        scope: target.scope,
        scopeLabel: target.scopeLabel,
        ...(mutation ? { action: mutation.action, source: mutation.source } : {}),
      });
      const launch = yield* resolveSpawnCommand(
        "node",
        ["--input-type=module", "-e", PI_PACKAGE_NATIVE_SOURCE, payload],
        { env: target.env },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(launch.command, launch.args, {
          cwd: target.cwd,
          env: target.env,
          shell: launch.shell,
          forceKillAfter: "2 seconds",
        }),
      );
      const [stdout, , code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 2 * 1024 * 1024 }),
          Stream.runDrain(child.stderr),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* error(
          "Pi package operation failed. Check the package source and Pi installation; native diagnostics are withheld because they may contain credentials.",
        );
      if (stdout.truncated || stdout.invalidUtf8)
        return yield* error("Pi package output exceeded its limit or was invalid.");
      const output = stdout.text
        .split(/\r?\n/u)
        .findLast((line) => line.startsWith("T3_PI_PACKAGES:"));
      return yield* Effect.try({
        try: () => decodeListJson(output?.slice("T3_PI_PACKAGES:".length) ?? ""),
        catch: () => error("Pi returned an invalid package list."),
      });
    },
    (effect, _target, mutation) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: mutation ? "5 minutes" : "20 seconds",
          orElse: () => Effect.fail(error("Pi package operation timed out.")),
        }),
        Effect.scoped,
      ),
  );
  const runLocked = (
    target: Effect.Success<ReturnType<typeof resolve>>,
    mutation?: PiPackageMutationInput,
  ) =>
    lock.withLock(
      `agent:${target.agentDir}`,
      target.scope === "project"
        ? lock.withLock(`project:${target.cwd}`, runNative(target, mutation))
        : runNative(target, mutation),
    );
  const mapFailure = (cause: unknown) =>
    Schema.is(PiPackageError)(cause)
      ? cause
      : error("Pi package operation failed. Check the selected instance and its Pi configuration.");
  return PiPackages.of({
    search: Effect.fn("PiPackages.search")(
      function* (input) {
        yield* decodeSearchInput(input);
        const url = new URL(CATALOG_URL);
        url.searchParams.set("name", input.query);
        if (input.type) url.searchParams.set("type", input.type);
        url.searchParams.set("sort", input.sort ?? "downloads");
        if (input.page !== undefined) url.searchParams.set("page", String(input.page));
        const response = yield* http
          .execute(HttpClientRequest.get(url.href))
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        const body = yield* collectUint8StreamText({
          stream: response.stream,
          maxBytes: 8 * 1024 * 1024,
        });
        if (body.truncated || body.invalidUtf8)
          return yield* error(
            "The official Pi catalog response exceeded its limit or was invalid.",
          );
        return yield* Effect.try({
          try: () => parsePiPackageCatalog(body.text, url.href),
          catch: mapFailure,
        });
      },
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(error("The official Pi catalog request timed out.")),
      }),
      Effect.mapError(mapFailure),
      Effect.scoped,
    ),
    list: Effect.fn("PiPackages.list")(function* (input) {
      const target = yield* resolve(input);
      return yield* runLocked(target);
    }, Effect.mapError(mapFailure)),
    mutate: Effect.fn("PiPackages.mutate")(function* (input) {
      yield* Schema.decodeUnknownEffect(PiPackageMutationInput)(input);
      yield* Effect.try({
        try: () => decodeSource(input.source),
        catch: () => error("Invalid package source."),
      });
      const target = yield* resolve(input);
      return yield* runLocked(target, input);
    }, Effect.mapError(mapFailure)),
  });
});

export const layer = Layer.effect(PiPackages, make);
