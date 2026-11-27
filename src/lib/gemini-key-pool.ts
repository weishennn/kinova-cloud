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

import { normalizeToCanonicalCategory, type CanonicalExpenseCategory } from './canonical-categories.ts';

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
const MODEL_TIMEOUT_COOLDOWN_MS = 3 * 60_000; // 3m cooldown on model timeout/network stall
const MODEL_SERVER_COOLDOWN_MS = 60_000; // 60s cooldown on model 5xx overload

export const STANDARD_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const STANDARD_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
] as const;

const STALLING_GEMINI_MODELS = new Set([
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest',
]);

export function sanitizeGeminiModelName(rawModel: string | undefined | null): string {
  const trimmed = String(rawModel || '').trim();
  if (!trimmed) return '';
  if (STALLING_GEMINI_MODELS.has(trimmed.toLowerCase())) {
    return STANDARD_GEMINI_MODEL;
  }
  return trimmed;
}

export function getStandardGeminiModelOrder(
  env: Record<string, string | undefined> = process.env
): string[] {
  const preferred = sanitizeGeminiModelName(env.GEMINI_MODEL);
  const models: string[] = [];
  if (preferred) {
    models.push(preferred);
  }
  for (const fallback of STANDARD_GEMINI_MODELS) {
    if (!models.includes(fallback)) {
      models.push(fallback);
    }
  }
  return models;
}

let roundRobinCursor = 0;
const keyCooldownUntil = new Map<string, number>();
const modelCooldownUntil = new Map<string, number>();

export function reportGeminiModelFailure(
  model: string,
  reason: 'timeout' | 'server' | 'network',
  now: number = Date.now()
): void {
  const clean = String(model || '').trim().toLowerCase();
  if (!clean) return;
  const duration = reason === 'server' ? MODEL_SERVER_COOLDOWN_MS : MODEL_TIMEOUT_COOLDOWN_MS;
  modelCooldownUntil.set(clean, now + duration);
}

export function orderModelsByHealth(models: string[], now: number = Date.now()): string[] {
  if (models.length <= 1) return [...models];
  const healthy: string[] = [];
  const coolingDown: string[] = [];
  for (const model of models) {
    const key = model.toLowerCase();
    const until = modelCooldownUntil.get(key) || 0;
    if (until > now) {
      coolingDown.push(model);
    } else {
      if (until > 0) modelCooldownUntil.delete(key);
      healthy.push(model);
    }
  }
  coolingDown.sort(
    (a, b) => (modelCooldownUntil.get(a.toLowerCase()) || 0) - (modelCooldownUntil.get(b.toLowerCase()) || 0)
  );
  return [...healthy, ...coolingDown];
}

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
  modelCooldownUntil.clear();
}

export function extractTextFromGeminiResponse(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const candidates = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';

  const textParts: string[] = [];
  for (const part of parts) {
    if (part && typeof part.text === 'string' && !part.thought) {
      textParts.push(part.text);
    }
  }
  return textParts.join('');
}

export function stripJsonFences(raw: string): string {
  let clean = raw.trim();
  const blockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (blockMatch) {
    clean = blockMatch[1].trim();
  }
  return clean;
}

export function buildThinkingConfigForModel(
  model: string,
  withThinking: boolean,
  thinkingBudget: number
): Record<string, unknown> {
  if (withThinking && thinkingBudget > 0) {
    return { thinkingBudget };
  }
  const normalizedModel = model.toLowerCase();
  if (normalizedModel.includes('gemini-2.5-pro')) {
    return { thinkingBudget: 128 };
  }
  if (/gemini-(?:3|4)|flash-latest/.test(normalizedModel)) {
    return { thinkingLevel: 'low' };
  }
  // Gemini 2.5 Flash disables dynamic thinking cleanly via thinkingBudget: 0.
  return { thinkingBudget: 0 };
}

export interface GenerateGeminiOptions {
  prompt: string;
  systemInstruction?: string;
  imageBase64?: string;
  mimeType?: string;
  thinking?: boolean;
  thinkingBudget?: number;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  googleSearch?: boolean;
  timeoutMs?: number;
  /** Hard deadline across all model and API-key retries. */
  totalTimeoutMs?: number;
  /** Prefer the same configured key slot as a preceding call in one multi-stage task. */
  preferredKeySlot?: number;
  /** Restrict a stage to its preferred healthy key; ignored if that key is cooling down. */
  onlyPreferredKey?: boolean;
  models?: string[];
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface GenerateGeminiResult {
  text: string;
  rawText: string;
  model: string;
  /** Stable, zero-based slot in the configured key list; never contains key material. */
  keySlot?: number;
  candidates?: unknown[];
}

/**
 * Single unified helper for calling Gemini across the entire Kinova application.
 *
 * Enforces:
 * - Healthy model order with automatic sanitization of known-stalling models
 * - Load-balanced key rotation and cooldown on 429/401/403
 * - Immediate model failover and cooldown on timeouts or 5xx overload
 * - Transparent retry on 400 when thinkingConfig/thinkingBudget is unsupported
 * - Concatenation of all non-thought parts (ignores `thought: true`)
 * - Bounded total deadline across all retries
 */
export async function generateGeminiContent(
  options: GenerateGeminiOptions
): Promise<GenerateGeminiResult> {
  const env = options.env || process.env;
  const configuredKeys = parseGeminiApiKeys(env);
  const apiKeys = getLoadBalancedGeminiKeys(env);
  if (apiKeys.length === 0) {
    throw new Error('GEMINI_API_KEY is not configured in server environment');
  }
  if (options.preferredKeySlot != null && Number.isInteger(options.preferredKeySlot)) {
    const preferredKey = configuredKeys[options.preferredKeySlot];
    const preferredIndex = preferredKey ? apiKeys.indexOf(preferredKey) : -1;
    const isHealthy = preferredKey && (keyCooldownUntil.get(preferredKey) || 0) <= Date.now();
    if (preferredIndex >= 0 && isHealthy) {
      if (preferredIndex > 0) {
        apiKeys.splice(preferredIndex, 1);
        apiKeys.unshift(preferredKey);
      }
      if (options.onlyPreferredKey) {
        apiKeys.splice(1);
      }
    }
  }

  const rawModels = options.models && options.models.length > 0
    ? options.models
    : getStandardGeminiModelOrder(env);
  const models = orderModelsByHealth(rawModels);

  const fetchImpl = options.fetchFn || fetch;
  const isThinkingTurn = options.thinking !== false;
  const defaultTimeout = isThinkingTurn ? 20_000 : 10_000;
  const timeoutMs = options.timeoutMs ?? defaultTimeout;
  const totalTimeoutMs =
    options.totalTimeoutMs && options.totalTimeoutMs > 0
      ? options.totalTimeoutMs
      : Math.max(timeoutMs + 8_000, isThinkingTurn ? 45_000 : 25_000);
  const deadline = Date.now() + totalTimeoutMs;

  const defaultTemp = isThinkingTurn ? 0.4 : 0.1;
  const temperature = options.temperature ?? defaultTemp;

  const defaultMaxTokens = isThinkingTurn ? 4096 : 2048;
  const maxOutputTokens = options.maxOutputTokens ?? defaultMaxTokens;

  const defaultBudget = isThinkingTurn ? (options.thinkingBudget ?? 2048) : 0;
  const thinkingBudget = options.thinkingBudget ?? defaultBudget;

  const cleanBase64 = options.imageBase64
    ? options.imageBase64.replace(/^data:[^;]+;base64,/, '').trim()
    : '';

  let lastError = 'No response from model';

  modelsLoop: for (let modelIdx = 0; modelIdx < models.length; modelIdx += 1) {
    const model = models[modelIdx];
    const hasMoreModels = modelIdx + 1 < models.length;

    for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx += 1) {
      const remainingTotalMs = deadline - Date.now();
      if (remainingTotalMs <= 0) {
        lastError = `Gemini request exceeded its ${totalTimeoutMs}ms total timeout`;
        break modelsLoop;
      }

      const apiKey = apiKeys[keyIdx];
      // Leave time budget for fallback models so one stalling model never exhausts the deadline.
      const perAttemptBudgetMs = hasMoreModels
        ? Math.min(timeoutMs, remainingTotalMs, Math.max(4_500, Math.floor(remainingTotalMs * 0.65)))
        : Math.min(timeoutMs, remainingTotalMs);

      const callModel = async (withThinking: boolean, omitThinkingConfig = false) => {
        const parts: Array<Record<string, unknown>> = [];
        if (cleanBase64) {
          parts.push({
            inline_data: {
              mime_type: options.mimeType || 'image/jpeg',
              data: cleanBase64,
            },
          });
        }
        parts.push({ text: options.prompt });

        const generationConfig: Record<string, unknown> = {
          temperature,
          maxOutputTokens,
        };
        if (options.responseMimeType && !options.googleSearch) {
          generationConfig.responseMimeType = options.responseMimeType;
        }
        if (!omitThinkingConfig) {
          generationConfig.thinkingConfig = buildThinkingConfigForModel(model, withThinking, thinkingBudget);
        }

        const reqBody: Record<string, unknown> = {
          contents: [{ role: 'user', parts }],
          generationConfig,
        };

        if (options.googleSearch) {
          reqBody.tools = [{ google_search: {} }];
        }

        if (options.systemInstruction) {
          reqBody.systemInstruction = {
            parts: [{ text: options.systemInstruction }],
          };
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const remainingTimeoutMs = Math.max(1, Math.min(perAttemptBudgetMs, deadline - Date.now()));
        return fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(remainingTimeoutMs),
        });
      };

      try {
        let res = await callModel(isThinkingTurn);

        // Transient 503 / 500 quick retry only when enough time budget remains
        if (res && (res.status === 503 || res.status === 500) && deadline - Date.now() > 2_500) {
          await new Promise((r) => setTimeout(r, 450));
          if (deadline - Date.now() > 1_000) {
            res = await callModel(isThinkingTurn);
          }
        }

        if (res.status === 400) {
          const errBody = await res.text().catch(() => '');
          console.warn(`[Gemini] Model ${model} returned 400:`, errBody.slice(0, 300));
          if (errBody.includes('thinkingConfig') || errBody.includes('thinkingBudget') || errBody.includes('thinkingLevel')) {
            if (deadline - Date.now() > 1_000) {
              console.warn(`[Gemini] Retrying ${model} without thinkingConfig...`);
              const retryRes = await callModel(false, true);
              if (retryRes.ok) {
                res = retryRes;
              } else {
                const retryErr = await retryRes.text().catch(() => '');
                console.warn(`[Gemini] Retry without thinkingConfig failed: ${retryRes.status} ${retryErr.slice(0, 200)}`);
                lastError = `Gemini ${retryRes.status}`;
                break;
              }
            } else {
              lastError = `Gemini 400: ${errBody.slice(0, 100)}`;
              break;
            }
          } else {
            lastError = `Gemini 400: ${errBody.slice(0, 100)}`;
            break;
          }
        }

        if (!res.ok) {
          lastError = `Gemini ${res.status}`;
          if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) {
            reportGeminiKeyFailure(apiKey, res.status);
            if (res.status >= 500 && hasMoreModels) {
              reportGeminiModelFailure(model, 'server');
              break; // Switch immediately to a healthier model on 5xx
            }
            if (keyIdx + 1 < apiKeys.length) {
              continue; // try next key
            }
          }
          // On 404 (e.g. gemini-2.5-flash on newer keys), try remaining keys only for 2.5 models before falling back
          if (res.status === 404 && keyIdx + 1 < apiKeys.length && model.toLowerCase().includes('gemini-2.5')) {
            continue;
          }
          break;
        }

        const responseData = await res.json();
        const rawText = extractTextFromGeminiResponse(responseData);
        if (!rawText) {
          lastError = 'Empty response from model';
          if (keyIdx + 1 < apiKeys.length && deadline - Date.now() > 1_200) {
            continue;
          }
          break;
        }

        const cleanText = stripJsonFences(rawText);
        return {
          text: cleanText,
          rawText,
          model,
          keySlot: configuredKeys.indexOf(apiKey) >= 0 ? configuredKeys.indexOf(apiKey) : undefined,
          candidates: responseData.candidates,
        };
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isTimeout =
          err instanceof Error &&
          (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(errorMsg));
        lastError = errorMsg;
        console.warn(`[Gemini] Attempt with model ${model} failed:`, errorMsg);
        if (Date.now() >= deadline) {
          lastError = `Gemini request exceeded its ${totalTimeoutMs}ms total timeout`;
          break modelsLoop;
        }
        reportGeminiModelFailure(model, isTimeout ? 'timeout' : 'network');
        // Fail over to the next model immediately instead of burning every key on a stalled model
        if (hasMoreModels) {
          break;
        }
      }
    }
  }

  throw new Error(lastError || 'Gemini request failed across all keys and models');
}

export interface GroundedWebSource {
  title: string;
  uri: string;
}

function sanitizeSourceText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, maxLength)
    : '';
}

export function extractGroundedSourcesFromCandidates(candidates: unknown, maxSources = 5): GroundedWebSource[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const firstCandidate = candidates[0] as { groundingMetadata?: { groundingChunks?: unknown } } | undefined;
  const groundingChunks = firstCandidate?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(groundingChunks)) return [];

  return groundingChunks
    .flatMap((chunk: unknown) => {
      const web = (chunk as { web?: Record<string, unknown> } | null)?.web;
      const uri = sanitizeSourceText(web?.uri, 500);
      const title = sanitizeSourceText(web?.title, 160);
      if (!uri || !/^https:\/\//i.test(uri)) return [];
      try {
        return [{ title: title || new URL(uri).hostname, uri }];
      } catch {
        return [];
      }
    })
    .filter((source, index, all) => all.findIndex((cand) => cand.uri === source.uri) === index)
    .slice(0, maxSources);
}

/**
 * Runs a fast Google-Search-grounded Gemini query with a bounded budget,
 * automatically falling back to direct generation if Search grounding is unavailable or times out.
 */
export async function generateGeminiWithSearchFallback(options: {
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  searchTimeoutMs?: number;
  searchTotalTimeoutMs?: number;
  directTimeoutMs?: number;
  directTotalTimeoutMs?: number;
  preferredSearchModel?: string;
  fetchFn?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<{ summary: string; sources: GroundedWebSource[]; model: string; grounded: boolean }> {
  const env = options.env || process.env;
  const baseOrder = getStandardGeminiModelOrder(env);
  const preferredSearch = sanitizeGeminiModelName(options.preferredSearchModel);
  // gemini-2.5-flash supports free-tier Google Search grounding reliably; keep fast lite fallbacks after it.
  const searchModels = [
    preferredSearch,
    'gemini-2.5-flash',
    ...baseOrder,
  ].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i);

  try {
    const searchRes = await generateGeminiContent({
      prompt: options.prompt,
      thinking: false,
      temperature: options.temperature ?? 0.1,
      maxOutputTokens: options.maxOutputTokens ?? 1000,
      googleSearch: true,
      models: searchModels,
      timeoutMs: options.searchTimeoutMs ?? 4_500,
      totalTimeoutMs: options.searchTotalTimeoutMs ?? 7_500,
      fetchFn: options.fetchFn,
      env,
    });
    const text = searchRes.rawText.trim();
    if (text) {
      return {
        summary: text,
        sources: extractGroundedSourcesFromCandidates(searchRes.candidates),
        model: searchRes.model,
        grounded: true,
      };
    }
  } catch {
    // Fall back immediately to direct generation
  }

  const directRes = await generateGeminiContent({
    prompt: options.prompt,
    thinking: false,
    temperature: options.temperature ?? 0.1,
    maxOutputTokens: options.maxOutputTokens ?? 1000,
    timeoutMs: options.directTimeoutMs ?? 8_000,
    totalTimeoutMs: options.directTotalTimeoutMs ?? 12_000,
    fetchFn: options.fetchFn,
    env,
  });

  return {
    summary: directRes.rawText.trim(),
    sources: [],
    model: directRes.model,
    grounded: false,
  };
}

/**
 * Classifies an unknown or ambiguous merchant or purchase description using Gemini LLM reasoning.
 * Returns the canonical category (e.g. 'Food & Dining') or null if classification fails or resolves to 'Other'.
 */
export async function classifyMerchantWithGemini(
  merchant: string,
  options?: {
    timeoutMs?: number;
    fetchFn?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  }
): Promise<CanonicalExpenseCategory | null> {
  const clean = String(merchant || '').trim();
  if (!clean || clean.length < 2) return null;

  try {
    const prompt = `You are an expert expense classifier.
Classify this merchant, store, or purchase description into exactly ONE of the canonical categories:
- Food & Dining (all restaurants, omakase, izakaya, kaiseki, cafes, kopitiams, food courts, hawker stalls, mamak, bakeries, bars, groceries, snacks, beverages, desserts)
- Transport (petrol, fuel, parking, tolls, Grab, trains, LRT, MRT, taxis, flights, transit)
- Shopping (retail, clothing, electronics, hardware, department stores, supermarkets, online shopping)
- Housing & Bills (utilities, rent, electricity, water, telecom, maintenance)
- Entertainment (movies, games, concerts, streaming, karaoke)
- Health (clinics, hospitals, pharmacy, dental, medicine)
- Education (tuition, courses, books, school fees)
- Sport (gym, badminton, sports gear, fitness)
- Parents (allowance, parents)
- Insurance (insurance policies, premiums)
- Gift (presents, donations, angpow)
- Other

Merchant: "${clean.replace(/"/g, '\\"')}"

Return ONLY valid JSON:
{"category": "category_name"}`;

    const res = await generateGeminiContent({
      prompt,
      responseMimeType: 'application/json',
      thinking: false,
      timeoutMs: options?.timeoutMs ?? 5000,
      totalTimeoutMs: options?.timeoutMs ?? 6000,
      fetchFn: options?.fetchFn,
      env: options?.env,
    });

    const parsed = JSON.parse(res.text);
    if (parsed && typeof parsed.category === 'string') {
      const canonical = normalizeToCanonicalCategory(parsed.category, 'Expense', clean);
      return canonical !== 'Other' ? (canonical as CanonicalExpenseCategory) : null;
    }
  } catch (err) {
    console.warn(`[Gemini] Merchant classification fallback for "${clean}" skipped:`, err instanceof Error ? err.message : String(err));
  }
  return null;
}

