export const PI_CONNECTION_CREDENTIALS_NATIVE_SOURCE = String.raw`
try {
  const { pathToFileURL } = await import("node:url");
  const { join, isAbsolute } = await import("node:path");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error("Invalid input");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  chunks.length = 0;
  if (input.consent !== true || typeof input.service !== "string" || input.service.length < 1 || input.service.length > 256 || ["__proto__", "constructor", "prototype"].includes(input.service) || /[\s\u0000-\u001f\u007f-\u009f]/u.test(input.service) || typeof input.apiKey !== "string" || input.apiKey.length > 8192 || !input.apiKey.trim() || input.apiKey.trimStart().startsWith("!") || /[\u0000-\u001f\u007f-\u009f]/u.test(input.apiKey) || !isAbsolute(input.agentDir) || !isAbsolute(input.sdkRoot)) throw new Error("Invalid input");
  const { AuthStorage } = await import(pathToFileURL(join(input.sdkRoot, "dist/core/auth-storage.js")).href);
  const auth = AuthStorage.create(join(input.agentDir, "auth.json"));
  const key = input.apiKey.replace(/\$/gu, () => "$$");
  await auth.modify(input.service, () => ({ type: "api_key", key }));
  process.stdout.write("T3_PI_CREDENTIALS_OK\n");
} catch {
  process.exitCode = 1;
}
`;
