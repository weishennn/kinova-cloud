import crypto from 'node:crypto';
import { ProxyAgent } from 'undici';

export interface BinanceConfig {
  apiKey: string;
  privateKey: string;
  keyType: 'ed25519' | 'hmac';
  baseUrl: string;
  proxyUrl?: string;
}

export interface BinanceApiResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
  code?: number;
  usedWeight1m?: number;
}

const DEFAULT_BASE_URLS = [
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
];

let cachedProxyUrl = '';
let cachedProxyAgent: ProxyAgent | undefined;

let cachedTimeOffsetMs = 0;
let lastTimeSyncAt = 0;
const TIME_SYNC_TTL_MS = 5 * 60 * 1000;

export function getBinanceProxyAgent(proxyUrl?: string): ProxyAgent | undefined {
  const clean = (proxyUrl || '').trim();
  if (!clean) return undefined;
  if (cachedProxyAgent && cachedProxyUrl === clean) {
    return cachedProxyAgent;
  }
  cachedProxyUrl = clean;
  cachedProxyAgent = new ProxyAgent(clean);
  return cachedProxyAgent;
}

export function normalizePrivateKeyPem(raw: string): string {
  return (raw || '').replace(/\\n/g, '\n').trim();
}

export function detectBinanceKeyType(secretOrKey: string): 'ed25519' | 'hmac' {
  const normalized = normalizePrivateKeyPem(secretOrKey);
  return normalized.includes('-----BEGIN') ? 'ed25519' : 'hmac';
}

export function getBinanceConfig(): BinanceConfig | null {
  const apiKey = (process.env.BINANCE_API_KEY || '').trim();
  const privateKey = normalizePrivateKeyPem(
    process.env.BINANCE_PRIVATE_KEY || process.env.BINANCE_SECRET_KEY || ''
  );
  const proxyUrl = (process.env.FIXIE_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
  const baseUrl = (process.env.BINANCE_API_BASE_URL || DEFAULT_BASE_URLS[0]).replace(/\/$/, '');

  if (!apiKey || !privateKey) {
    return null;
  }

  return {
    apiKey,
    privateKey,
    keyType: detectBinanceKeyType(privateKey),
    baseUrl,
    proxyUrl: proxyUrl || undefined,
  };
}

/**
 * Signs a query/body payload string using either:
 * - Ed25519 private key PEM -> Base64 signature (Binance recommended)
 * - HMAC-SHA256 secret string -> lowercase Hex signature
 */
export function signBinancePayload(payload: string, secretOrPem: string): string {
  const normalized = normalizePrivateKeyPem(secretOrPem);
  if (normalized.includes('-----BEGIN')) {
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), normalized);
    return sig.toString('base64');
  }
  return crypto.createHmac('sha256', normalized).update(payload, 'utf8').digest('hex');
}

function buildFetchInit(init: RequestInit, proxyUrl?: string): RequestInit {
  const dispatcher = getBinanceProxyAgent(proxyUrl);
  if (!dispatcher) return init;
  return {
    ...init,
    // Node.js native fetch (powered by undici) accepts `dispatcher` for static IP proxies (e.g. FIXIE_URL).
    dispatcher,
  } as RequestInit;
}

async function fetchWithProxy(url: string, init: RequestInit, proxyUrl?: string): Promise<Response> {
  return fetch(url, buildFetchInit(init, proxyUrl));
}

export async function syncBinanceServerTime(config?: BinanceConfig | null): Promise<number> {
  const now = Date.now();
  if (lastTimeSyncAt > 0 && now - lastTimeSyncAt < TIME_SYNC_TTL_MS) {
    return cachedTimeOffsetMs;
  }

  const baseUrl = config?.baseUrl || DEFAULT_BASE_URLS[0];
  try {
    const res = await fetchWithProxy(
      `${baseUrl}/api/v3/time`,
      { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(8000) },
      config?.proxyUrl
    );
    if (res.ok) {
      const json = (await res.json()) as { serverTime?: number };
      if (typeof json.serverTime === 'number' && Number.isFinite(json.serverTime)) {
        cachedTimeOffsetMs = json.serverTime - Date.now();
        lastTimeSyncAt = Date.now();
      }
    }
  } catch {
    // Keep previous offset if time check fails transiently
  }
  return cachedTimeOffsetMs;
}

function formatBinanceError(status: number, code?: number, msg?: string): string {
  if (status === 451) {
    return 'Binance blocked this server region (HTTP 451). Ensure FIXIE_URL points to a non-US proxy region (e.g. Singapore or EU).';
  }
  if (status === 418) {
    return 'Binance temporarily banned this IP for rate-limit violation (HTTP 418). Wait before retrying.';
  }
  if (status === 429) {
    return 'Binance rate limit reached (HTTP 429). Please retry in a moment.';
  }
  if (code === -1021) {
    return 'Binance timestamp drifted outside recvWindow (-1021). Try again to resync clock.';
  }
  if (code === -1022) {
    return 'Invalid Binance API signature (-1022). Check that BINANCE_PRIVATE_KEY matches the public key registered on Binance.';
  }
  if (code === -2015) {
    return 'Invalid Binance API key, IP not whitelisted, or missing Read permission (-2015).';
  }
  return msg || `Binance HTTP ${status}`;
}

export async function callBinancePublic<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean> = {},
  config?: BinanceConfig | null
): Promise<BinanceApiResult<T>> {
  const effectiveConfig = config ?? getBinanceConfig();
  const baseUrl = effectiveConfig?.baseUrl || DEFAULT_BASE_URLS[0];
  const proxyUrl = effectiveConfig?.proxyUrl;

  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;

  try {
    const res = await fetchWithProxy(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      },
      proxyUrl
    );
    const usedWeight1m = Number(res.headers.get('x-mbx-used-weight-1m') || 0) || undefined;
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      const errObj = json && typeof json === 'object' ? (json as { code?: number; msg?: string }) : {};
      return {
        success: false,
        status: res.status,
        code: errObj.code,
        usedWeight1m,
        error: formatBinanceError(res.status, errObj.code, errObj.msg || text.slice(0, 200)),
      };
    }

    return {
      success: true,
      data: json as T,
      status: res.status,
      usedWeight1m,
    };
  } catch (err) {
    return {
      success: false,
      status: 502,
      error: err instanceof Error ? err.message : 'Failed to connect to Binance API.',
    };
  }
}

export async function callBinanceSigned<T = unknown>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    params?: Record<string, string | number | boolean | undefined>;
    config?: BinanceConfig;
    recvWindow?: number;
  } = {}
): Promise<BinanceApiResult<T>> {
  const config = options.config || getBinanceConfig();
  if (!config) {
    return {
      success: false,
      status: 401,
      error: 'Binance API credentials not configured. Set BINANCE_API_KEY and BINANCE_PRIVATE_KEY.',
    };
  }

  const offsetMs = await syncBinanceServerTime(config);
  const method = options.method || 'GET';

  const buildRequest = (timestampMs: number) => {
    const search = new URLSearchParams();
    Object.entries(options.params || {}).forEach(([key, val]) => {
      if (val !== undefined && val !== null && val !== '') {
        search.set(key, String(val));
      }
    });
    search.set('recvWindow', String(options.recvWindow ?? 10000));
    search.set('timestamp', String(timestampMs));

    const payload = search.toString();
    const signature = signBinancePayload(payload, config.privateKey);
    const signedQuery = `${payload}&signature=${encodeURIComponent(signature)}`;

    const url = method === 'GET'
      ? `${config.baseUrl}${path}?${signedQuery}`
      : `${config.baseUrl}${path}`;

    return {
      url,
      init: {
        method,
        headers: {
          'X-MBX-APIKEY': config.apiKey,
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(method === 'POST' ? { body: signedQuery } : {}),
        cache: 'no-store' as const,
        signal: AbortSignal.timeout(15000),
      },
    };
  };

  try {
    let req = buildRequest(Date.now() + offsetMs);
    let res = await fetchWithProxy(req.url, req.init, config.proxyUrl);
    let text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    // Retry once on -1021 timestamp drift after forced clock resync
    if (!res.ok && json && typeof json === 'object' && (json as { code?: number }).code === -1021) {
      lastTimeSyncAt = 0;
      const freshOffset = await syncBinanceServerTime(config);
      req = buildRequest(Date.now() + freshOffset);
      res = await fetchWithProxy(req.url, req.init, config.proxyUrl);
      text = await res.text().catch(() => '');
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    const usedWeight1m = Number(res.headers.get('x-mbx-used-weight-1m') || 0) || undefined;

    if (!res.ok) {
      const errObj = json && typeof json === 'object' ? (json as { code?: number; msg?: string }) : {};
      return {
        success: false,
        status: res.status,
        code: errObj.code,
        usedWeight1m,
        error: formatBinanceError(res.status, errObj.code, errObj.msg || text.slice(0, 200)),
      };
    }

    return {
      success: true,
      data: json as T,
      status: res.status,
      usedWeight1m,
    };
  } catch (err) {
    return {
      success: false,
      status: 502,
      error: err instanceof Error ? err.message : 'Network error calling Binance API.',
    };
  }
}
