import { useAtomValue } from "@effect/atom-react";
import {
  PiPackageSource,
  type EnvironmentId,
  type PiPackageListResult,
  type PiPackageMutationInput,
  type PiPackageSearchResult,
  type PiPackageSearchInput,
  type PiPackageTarget,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createPiPackageCommands } from "@t3tools/client-runtime/state/piPackages";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { PackageIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import type { PluginsPackageDestination } from "./pluginsPackageScope";

const commands = createPiPackageCommands(connectionAtomRuntime);
const isPackageSource = Schema.is(PiPackageSource);
const packageTypes = ["extension", "skill", "theme", "prompt"] as const;
const sortLabels = {
  downloads: "Most downloads",
  recent: "Recently published",
  name: "A–Z",
} as const;

export function isPiPackageInstalled(source: string, installedSources: readonly string[]) {
  const npmIdentity = (value: string) =>
    /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@(?:[a-zA-Z][a-zA-Z0-9._-]*|[~^]?[0-9][a-zA-Z0-9.+*-]*))?$/.exec(
      value,
    )?.[1];
  const identity = npmIdentity(source);
  return installedSources.some(
    (installedSource) =>
      installedSource === source ||
      (identity !== undefined &&
        source === `npm:${identity}` &&
        npmIdentity(installedSource) === identity),
  );
}
type PiPackagesSettingsProps = {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly destination: PluginsPackageDestination;
};

function failureMessage(result: AtomCommandResult<unknown, unknown>, fallback: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
}

function packageName(source: string) {
  if (source.startsWith("npm:")) {
    const specifier = source.slice(4);
    const versionAt = specifier.lastIndexOf("@");
    return versionAt > 0 ? specifier.slice(0, versionAt) : specifier;
  }
  const repository = source.startsWith("git:") || /^(https?|ssh):\/\//.test(source);
  const location = repository ? (source.replace(/^git:/, "").split(/[?#]/)[0] ?? source) : source;
  const name = location
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1);
  return name?.replace(/\.git$/, "") || source;
}

function PackageSource({ source }: { readonly source: string }) {
  return (
    <p
      className="truncate text-xs text-muted-foreground"
      title={source}
      aria-label={`Package source: ${source}`}
    >
      {source}
    </p>
  );
}

export function PiPackagesSettings(props: PiPackagesSettingsProps) {
  return (
    <PiPackagesScope
      key={JSON.stringify([props.environmentId, props.instanceId, props.destination])}
      {...props}
    />
  );
}

function PiPackagesScope({ environmentId, instanceId, destination }: PiPackagesSettingsProps) {
  const target: PiPackageTarget = { instanceId, ...destination };
  const canList = useAtomValue(commands.list.permissionAtom(environmentId));
  const canSearch = useAtomValue(commands.search.permissionAtom(environmentId));
  const canMutate = useAtomValue(commands.mutate.permissionAtom(environmentId));
  return (
    <section aria-label="Pi packages" className="space-y-6 p-4">
      <p className="text-sm text-muted-foreground">
        Make Pi your own with extensions, skills, themes, and prompts.
      </p>
      {!canMutate ? (
        <p role="status" className="text-xs text-muted-foreground">
          Installing, updating, and removing packages requires providers:manage permission.
        </p>
      ) : null}
      <PiPackagesTarget
        key={JSON.stringify([target, canList, canSearch, canMutate])}
        environmentId={environmentId}
        target={target}
        canList={canList}
        canSearch={canSearch}
        canMutate={canMutate}
      />
    </section>
  );
}

function PiPackagesTarget({
  environmentId,
  target,
  canList,
  canSearch,
  canMutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: PiPackageTarget;
  readonly canList: boolean;
  readonly canSearch: boolean;
  readonly canMutate: boolean;
}) {
  const list = useAtomCommand(commands.list, { reportFailure: false });
  const search = useAtomCommand(commands.search, { reportFailure: false });
  const mutate = useAtomCommand(commands.mutate, { reportFailure: false });
  const [installed, setInstalled] = useState<PiPackageListResult | null>(null);
  const [catalog, setCatalog] = useState<PiPackageSearchResult | null>(null);
  const [tab, setTab] = useState<"installed" | "discover">("installed");
  const tabId = useId();
  const [catalogRequest, setCatalogRequest] = useState<PiPackageSearchInput>({
    query: "",
    sort: "downloads",
    page: 1,
  });
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [listing, setListing] = useState(canList);
  const [searching, setSearching] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pick<PiPackageMutationInput, "action" | "source"> | null>(
    null,
  );
  const active = useRef(false);
  const listGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const mutationLock = useRef(false);
  const load = async () => {
    if (!canList) return;
    const generation = ++listGeneration.current;
    const result = await list({ environmentId, input: target });
    if (!active.current || generation !== listGeneration.current) return;
    setListing(false);
    if (result._tag === "Success") setInstalled(result.value);
    else setListError(failureMessage(result, "Could not load installed Pi packages."));
  };
  const refresh = () => {
    if (!canList) return;
    setListing(true);
    setListError(null);
    void load();
  };
  const { instanceId, scope, projectId } = target;
  useEffect(() => {
    active.current = true;
    const generation = ++listGeneration.current;
    if (canList) {
      void list({
        environmentId,
        input: { instanceId, scope, ...(projectId ? { projectId } : {}) },
      }).then((result) => {
        if (!active.current || generation !== listGeneration.current) return;
        setListing(false);
        if (result._tag === "Success") setInstalled(result.value);
        else setListError(failureMessage(result, "Could not load installed Pi packages."));
      });
    }
    return () => {
      active.current = false;
      listGeneration.current += 1;
      searchGeneration.current += 1;
    };
  }, [canList, environmentId, instanceId, list, projectId, scope]);
  const searchCatalog = useCallback(
    async (input: PiPackageSearchInput) => {
      if (!canSearch) return;
      const generation = ++searchGeneration.current;
      setSearching(true);
      setSearchError(null);
      setCatalog(null);
      const result = await search({ environmentId, input });
      if (!active.current || generation !== searchGeneration.current) return;
      setSearching(false);
      if (result._tag === "Success") setCatalog(result.value);
      else
        setSearchError(failureMessage(result, "Could not search the official Pi package catalog."));
    },
    [canSearch, environmentId, search],
  );
  useEffect(() => {
    if (tab === "discover" && canSearch) void searchCatalog(catalogRequest);
    else setSearching(false);
    return () => {
      searchGeneration.current += 1;
    };
  }, [tab, canSearch, catalogRequest, searchCatalog]);
  const submitSearch = () => setCatalogRequest({ ...catalogRequest, query, page: 1 });
  const confirmMutation = async () => {
    if (!pending || !canMutate || mutationLock.current) return;
    mutationLock.current = true;
    setMutating(true);
    setMutationError(null);
    const result = await mutate({ environmentId, input: { ...target, ...pending, consent: true } });
    if (!active.current) return;
    mutationLock.current = false;
    setMutating(false);
    setPending(null);
    if (result._tag === "Success") {
      listGeneration.current += 1;
      setListing(false);
      setListError(null);
      setInstalled(result.value);
      toastManager.add({
        type: "success",
        title: "Pi packages changed",
        description: "Runtime changes apply to the next session. Active sessions are not stopped.",
      });
    } else {
      const message = failureMessage(result, "Could not change this Pi package.");
      setMutationError(message);
      if (message)
        toastManager.add({
          type: "error",
          title: "Pi package operation failed",
          description: message,
        });
    }
  };
  const manualSource = source.trim();
  const validSource = isPackageSource(manualSource);
  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Plugin views"
        className="flex items-center gap-1"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "installed"
              : event.key === "End"
                ? "discover"
                : tab === "installed"
                  ? "discover"
                  : "installed";
          setTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
        }}
      >
        {(["installed", "discover"] as const).map((view) => (
          <Button
            key={view}
            role="tab"
            id={`${tabId}-${view}`}
            data-tab={view}
            aria-selected={tab === view}
            aria-controls={`${tabId}-${view}-panel`}
            tabIndex={tab === view ? 0 : -1}
            variant={tab === view ? "secondary" : "ghost-muted"}
            size="sm"
            onClick={() => setTab(view)}
          >
            {view === "installed" ? "Installed" : "Discover"}
          </Button>
        ))}
      </div>
      {tab === "discover" ? (
        <div
          role="tabpanel"
          id={`${tabId}-discover-panel`}
          aria-labelledby={`${tabId}-discover`}
          tabIndex={0}
        >
          <section
            aria-label="Discover plugins"
            className="space-y-4 rounded-xl border border-border/60 bg-muted/15 p-4"
          >
            <div className="space-y-1">
              <h4 className="text-sm font-medium">Discover</h4>
              <p className="text-xs text-muted-foreground">
                Explore Pi's official catalog and find something new for your workflow.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Search official Pi packages"
                type="search"
                placeholder="Search extensions, skills, themes…"
                maxLength={200}
                value={query}
                disabled={!canSearch}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSearch && !searching) {
                    event.preventDefault();
                    submitSearch();
                  }
                }}
              />
              <Button size="sm" disabled={!canSearch || searching} onClick={submitSearch}>
                {searching ? "Searching…" : "Search"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                name="package-category"
                disabled={!canSearch}
                value={catalogRequest.type ?? "all"}
                onValueChange={(value) => {
                  const selectedType = packageTypes.find((type) => type === value);
                  setCatalogRequest({
                    query,
                    sort: catalogRequest.sort ?? "downloads",
                    page: 1,
                    ...(selectedType ? { type: selectedType } : {}),
                  });
                }}
              >
                <SelectTrigger size="sm" aria-label="Package category">
                  <SelectValue>{catalogRequest.type ?? "All types"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="all">All types</SelectItem>
                  {packageTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                name="package-sort"
                disabled={!canSearch}
                value={catalogRequest.sort ?? "downloads"}
                onValueChange={(value) => {
                  if (value === "downloads" || value === "recent" || value === "name")
                    setCatalogRequest({ ...catalogRequest, query, sort: value, page: 1 });
                }}
              >
                <SelectTrigger size="sm" aria-label="Package sort">
                  <SelectValue>{sortLabels[catalogRequest.sort ?? "downloads"]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(sortLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {searching ? (
              <p role="status" className="text-xs text-muted-foreground">
                Loading packages…
              </p>
            ) : null}
            {searchError ? (
              <p role="alert" className="text-xs text-destructive">
                {searchError}
              </p>
            ) : null}
            {!canSearch ? (
              <p role="status" className="text-xs text-muted-foreground">
                Catalog discovery is unavailable with the current permissions.
              </p>
            ) : null}
            {catalog?.packages.length === 0 ? (
              <p role="status" className="text-xs text-muted-foreground">
                No official packages found.
              </p>
            ) : null}
            {catalog && catalog.packages.length > 0 ? (
              <ul
                aria-label="Catalog packages"
                className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
              >
                {catalog.packages.map((entry) => (
                  <li
                    key={entry.source}
                    className="flex min-w-0 flex-col justify-between gap-4 rounded-xl border border-border/60 bg-background p-4"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <p className="truncate text-sm font-medium" title={entry.name}>
                        {entry.name}
                      </p>
                      {entry.description ? (
                        <p
                          className="line-clamp-2 text-xs text-muted-foreground"
                          title={entry.description}
                        >
                          {entry.description}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-1">
                        {entry.types.map((type) => (
                          <Badge key={type} variant="secondary" size="sm">
                            {type}
                          </Badge>
                        ))}
                      </div>
                      <PackageSource source={entry.source} />
                      {entry.author || entry.monthlyDownloads !== undefined || entry.publishedAt ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {entry.author ? <span>By {entry.author}</span> : null}
                          {entry.monthlyDownloads !== undefined ? (
                            <span
                              title={`${entry.monthlyDownloads.toLocaleString()} monthly downloads`}
                            >
                              {entry.monthlyDownloads.toLocaleString(undefined, {
                                notation: "compact",
                                maximumFractionDigits: 1,
                              })}{" "}
                              downloads / month
                            </span>
                          ) : null}
                          {entry.publishedAt ? (
                            <time dateTime={entry.publishedAt} title={entry.publishedAt}>
                              Published {new Date(entry.publishedAt).toLocaleDateString()}
                            </time>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex justify-end">
                      <Button
                        size="compact"
                        variant="outline"
                        aria-label={`Install ${entry.name}`}
                        disabled={
                          !canMutate ||
                          mutating ||
                          isPiPackageInstalled(
                            entry.source,
                            installed?.packages.map((item) => item.source) ?? [],
                          )
                        }
                        onClick={() => setPending({ action: "install", source: entry.source })}
                      >
                        {isPiPackageInstalled(
                          entry.source,
                          installed?.packages.map((item) => item.source) ?? [],
                        )
                          ? "Installed"
                          : "Install"}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {catalog ? (
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                <p role="status">
                  {catalog.pagination
                    ? `Page ${catalog.pagination.page.toLocaleString()} · ${catalog.pagination.rangeStart !== undefined && catalog.pagination.rangeEnd !== undefined ? `${catalog.pagination.rangeStart.toLocaleString()}–${catalog.pagination.rangeEnd.toLocaleString()} shown` : `${catalog.packages.length.toLocaleString()} results shown`} · Catalog: ${catalog.pagination.catalogTotal.toLocaleString()} packages`
                    : `${catalog.packages.length.toLocaleString()} packages returned; total catalog size unavailable.`}
                </p>
                {catalog.pagination ? (
                  <div className="flex gap-2">
                    <Button
                      size="compact"
                      variant="outline"
                      disabled={!canSearch || searching || !catalog.pagination.hasPrevious}
                      onClick={() =>
                        setCatalogRequest({ ...catalogRequest, page: catalog.pagination!.page - 1 })
                      }
                    >
                      Previous
                    </Button>
                    <Button
                      size="compact"
                      variant="outline"
                      disabled={!canSearch || searching || !catalog.pagination.hasNext}
                      onClick={() =>
                        setCatalogRequest({ ...catalogRequest, page: catalog.pagination!.page + 1 })
                      }
                    >
                      Next
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`${tabId}-installed-panel`}
          aria-labelledby={`${tabId}-installed`}
          tabIndex={0}
          className="space-y-4"
        >
          <section aria-label="Installed plugins" className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium" title={installed?.scopeLabel}>
                Installed{installed ? ` (${installed.packages.length})` : ""}
              </h4>
              <Button
                size="compact"
                variant="ghost-muted"
                aria-label="Refresh packages"
                disabled={!canList || listing || mutating}
                onClick={() => void refresh()}
              >
                {listing ? "Loading…" : "Refresh"}
              </Button>
            </div>
            {!canList ? (
              <p role="status" className="text-xs text-muted-foreground">
                Installed packages are unavailable with the current permissions.
              </p>
            ) : null}
            {listError ? (
              <p role="alert" className="text-xs text-destructive">
                {listError}
              </p>
            ) : null}
            {installed?.packages.length === 0 ? (
              <p
                role="status"
                className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground"
              >
                No packages installed here yet. Browse the catalog to get started.
              </p>
            ) : null}
            {installed && installed.packages.length > 0 ? (
              <ul
                aria-label="Installed packages"
                className="max-h-96 divide-y divide-border/60 overflow-y-auto rounded-xl border border-border/60 px-3"
              >
                {installed.packages.map((entry) => (
                  <li key={entry.source} className="flex items-center gap-3 py-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <PackageIcon className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="truncate text-sm font-medium" title={packageName(entry.source)}>
                        {packageName(entry.source)}
                      </p>
                      <PackageSource source={entry.source} />
                      {entry.filtered ? (
                        <p className="text-xs text-muted-foreground">Resource filters configured</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="compact"
                        variant="outline"
                        aria-label={`Update ${entry.source}`}
                        disabled={!canMutate || mutating}
                        onClick={() => setPending({ action: "update", source: entry.source })}
                      >
                        Update
                      </Button>
                      <Button
                        size="compact"
                        variant="ghost-destructive"
                        aria-label={`Remove ${entry.source}`}
                        disabled={!canMutate || mutating}
                        onClick={() => setPending({ action: "remove", source: entry.source })}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Changes apply to the next session. Active sessions keep running.
            </p>
          </section>
          <details className="rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Install from a package source
            </summary>
            <div className="space-y-3 pt-3">
              <p className="text-xs text-muted-foreground">
                Use an npm package, Git URL, or local path on this environment.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Pi package source"
                  placeholder="npm:package, Git URL, or local path"
                  value={source}
                  maxLength={2048}
                  disabled={!canMutate || mutating}
                  onChange={(event) => setSource(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canMutate || mutating || !validSource}
                  onClick={() => setPending({ action: "install", source: manualSource })}
                >
                  Install source
                </Button>
              </div>
              {source && !validSource ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Enter a valid npm, git, or local package source; option flags are not allowed.
                </p>
              ) : null}
            </div>
          </details>
        </div>
      )}
      {mutationError ? <p role="alert">{mutationError}</p> : null}
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !mutating) setPending(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.action === "remove"
                ? "Remove Pi package?"
                : "Allow package code execution?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.action === "remove"
                ? "Remove this package from the selected scope."
                : "Installing or updating packages can execute third-party code on the selected environment. Only proceed if you trust this source."}{" "}
              Runtime changes apply to the next session. Active sessions are not stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all px-6 font-mono text-xs">{pending?.source}</p>
          <AlertDialogFooter>
            <Button variant="outline" disabled={mutating} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button disabled={!canMutate || mutating} onClick={() => void confirmMutation()}>
              {mutating
                ? "Applying..."
                : pending?.action === "remove"
                  ? "Confirm removal"
                  : "I trust this source - continue"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
