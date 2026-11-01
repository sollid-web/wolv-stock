export function resolvePublicRpcUrl(
  configuredUrl: string | undefined,
  fallbackUrl: string,
  variableName: string,
): string {
  const value = configuredUrl || fallbackUrl;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a public HTTP(S) RPC URL.`);
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      `${variableName} must be a public HTTP(S) RPC URL without credentials, path tokens, query parameters, or fragments.`,
    );
  }
  return url.toString();
}

export function redactRpcEndpointIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/<redacted>`;
  } catch {
    return "invalid RPC endpoint (redacted)";
  }
}
