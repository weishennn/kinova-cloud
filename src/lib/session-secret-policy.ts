export function getConfiguredSessionSecret(
  env: Record<string, string | undefined> = process.env
): string {
  for (const candidate of [env.AUTH_SECRET, env.GOOGLE_CLIENT_SECRET, env.CASHFLOW_PROXY_TOKEN]) {
    if (candidate && candidate.trim()) return candidate;
  }
  return '';
}
