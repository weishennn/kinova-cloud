/**
 * Multi-Key Load Balancer & Automatic Failover Pool for Google Gemini API.
 *
 * Supports configuring 3 or more Gemini API keys via:
 * 1. Comma/newline-separated list in `GEMINI_API_KEY` or `GEMINI_API_KEYS`
 *    e.g. `GEMINI_API_KEY=AIzaSyKey1,AIzaSyKey2,AIzaSyKey3`
 * 2. Numbered environment variables:
 *    `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, ... up to `GEMINI_API_KEY_10`
 *
 * Behavior:
 * - Round-robin distributes incoming requests evenly across all healthy keys.
 * - If a key hits HTTP 429 (rate limit / quota exhausted) or HTTP 401/403,
 *   it is placed in temporary cooldown and the request transparently fails over
 *   to the next available key in the pool.
 */

const NUMBERED_KEY_NAMES = [
  'GEMINI_API_KEY_1',
  'GEMINI_API_KEY_2',
  'GEMINI_API_KEY_3',
  'GEMINI_API_KEY_4',
  'GEMINI_API_KEY_5',
  'GEMINI_API_KEY_6',
  'GEMINI_API_KEY_7',
  'GEMINI_API_KEY_8',
  'GEMINI_API_KEY_9',
  'GEMINI_API_KEY_10',
] as const;

const QUOTA_COOLDOWN_MS = 60_000; // 60s cooldown on HTTP 429
const AUTH_COOLDOWN_MS = 10 * 60_000; // 10m cooldown on HTTP 401/403

export const STANDARD_GEMINI_MODEL = 'gemini-flash-latest';
export const STANDARD_GEMINI_MODELS = [
  'gemini-flash-latest',
  'gemini-3.8-flash',
  'gemini-2.5-flash',
] as const;

let roundRobinCursor = 0;
const keyCooldownUntil = new Map<string, number>();

export function splitRawKeyString(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[\s,;]+/)
    .map((k) => k.trim().replace(/^['"]+|['"]+$/g, '').trim())
    .filter(Boolean);
}

/**
 * Extracts all unique Gemini API keys configured in the environment.
 */
export function parseGeminiApiKeys(
  env: Record<string, string | undefined> = process.env
): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  const addCandidates = (raw: string | undefined) => {
    for (const candidate of splitRawKeyString(raw)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        keys.push(candidate);
      }
    }
  };

  addCandidates(env.GEMINI_API_KEY);
  addCandidates(env.GEMINI_API_KEYS);
  for (const name of NUMBERED_KEY_NAMES) {
    addCandidates(env[name]);
  }

  return keys;
}

/**
 * Returns the configured Gemini API keys in load-balanced (round-robin) order,
 * prioritizing healthy keys over keys currently in rate-limit cooldown.
 */
export function getLoadBalancedGeminiKeys(
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now()
): string[] {
  const allKeys = parseGeminiApiKeys(env);
  if (allKeys.length <= 1) return allKeys;

  const startIndex = roundRobinCursor % allKeys.length;
  roundRobinCursor = (roundRobinCursor + 1) % allKeys.length;

  const rotated: string[] = [];
  for (let i = 0; i < allKeys.length; i += 1) {
    rotated.push(allKeys[(startIndex + i) % allKeys.length]);
  }

  const healthy: string[] = [];
  const coolingDown: string[] = [];

  for (const key of rotated) {
    const until = keyCooldownUntil.get(key) || 0;
    if (until > now) {
      coolingDown.push(key);
    } else {
      if (until > 0) keyCooldownUntil.delete(key);
      healthy.push(key);
    }
  }

  // Sort cooling-down keys by earliest recovery time as a last-resort fallback
  coolingDown.sort((a, b) => (keyCooldownUntil.get(a) || 0) - (keyCooldownUntil.get(b) || 0));

  return [...healthy, ...coolingDown];
}

/**
 * Marks a key as temporarily cooled down when it encounters 429 (quota) or 401/403 (auth).
 */
export function reportGeminiKeyFailure(
  apiKey: string,
  status: number,
  now: number = Date.now()
): void {
  if (!apiKey) return;
  if (status === 429) {
    keyCooldownUntil.set(apiKey, now + QUOTA_COOLDOWN_MS);
  } else if (status === 401 || status === 403) {
    keyCooldownUntil.set(apiKey, now + AUTH_COOLDOWN_MS);
  } else if (status >= 500) {
    keyCooldownUntil.set(apiKey, now + 15_000);
  }
}

export function resetGeminiKeyPoolStateForTests(): void {
  roundRobinCursor = 0;
  keyCooldownUntil.clear();
}
