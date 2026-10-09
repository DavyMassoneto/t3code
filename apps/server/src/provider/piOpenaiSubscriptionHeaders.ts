export const PI_OPENAI_SUBSCRIPTION_HEADERS_SOURCE = String.raw`
function readOpenaiSubscriptionHeaders(headers, checkedAt) {
  if (!headers || typeof headers !== "object" || typeof checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt)) || new Date(checkedAt).toISOString() !== checkedAt) return undefined;
  const header = name => {
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
    return key === undefined || typeof headers[key] !== "string" ? undefined : headers[key].trim();
  };
  const number = value => typeof value === "string" && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : undefined;
  const integer = value => typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
  const metrics = [];
  for (const [id, label] of [["primary", "Primary subscription window"], ["secondary", "Secondary subscription window"]]) {
    const used = number(header("x-codex-" + id + "-used-percent"));
    if (used === undefined) continue;
    const minutes = integer(header("x-codex-" + id + "-window-minutes"));
    const seconds = minutes !== undefined && minutes >= 0 && Number.isSafeInteger(minutes * 60) ? minutes * 60 : undefined;
    const reset = integer(header("x-codex-" + id + "-reset-at"));
    const resetsAt = reset !== undefined && Math.abs(reset) <= 8640000000000 ? new Date(reset * 1000).toISOString() : undefined;
    metrics.push({id, label, unit: "percent", used, limit: 100, ...(seconds !== undefined ? {windowSeconds: seconds} : {}), ...(resetsAt ? {resetsAt} : {})});
  }
  const hasCredits = header("x-codex-credits-has-credits");
  const unlimited = header("x-codex-credits-unlimited");
  const balance = number(header("x-codex-credits-balance"));
  if (["true", "false"].includes(hasCredits) && unlimited === "false" && balance !== undefined) metrics.push({id: "balance", label: "Credit balance", unit: "credits", remaining: balance});
  return metrics.length ? {status: "available", source: "openai-inference-response-headers", checkedAt, metrics} : undefined;
}
`;
