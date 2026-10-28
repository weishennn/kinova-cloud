import crypto from 'crypto';

export interface MoomooConfig {
  apiKey: string;
  secretKey: string;
  accountId?: string;
  proxyUrl?: string;
  baseUrl?: string;
}

export function getMoomooConfig(): MoomooConfig | null {
  const apiKey = (process.env.MOOMOO_API_KEY || '').trim();
  const secretKey = (process.env.MOOMOO_SECRET_KEY || process.env.MOOMOO_PRIVATE_KEY || '').trim();
  const accountId = (process.env.MOOMOO_ACCOUNT_ID || '').trim();
  const proxyUrl = (process.env.FIXIE_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || '').trim();

  if (!apiKey || !secretKey) {
    return null;
  }

  return {
    apiKey,
    secretKey,
    accountId,
    proxyUrl,
    baseUrl: (process.env.MOOMOO_API_BASE_URL || 'https://webapi.moomoo.com').replace(/\/$/, ''),
  };
}

/**
 * Builds the signature base string per Moomoo OpenAPI Traditional API Key spec:
 * {timestamp_ms}\n{http_method}\n{request_path}\n{query_string}\n{body_part}
 */
export function buildMoomooSignatureString(params: {
  timestamp: string;
  method: string;
  path: string;
  queryString?: string;
  body?: string;
}): string {
  const methodUpper = params.method.toUpperCase();
  const query = (params.queryString || '').replace(/^\?/, '');
  const bodyPart = params.body || '';
  return `${params.timestamp}\n${methodUpper}\n${params.path}\n${query}\n${bodyPart}`;
}

/**
 * Signs the payload using either RSA-SHA256 (if PEM formatted private key)
 * or HMAC-SHA256 (if standard secret string).
 */
export function signMoomooRequest(signingString: string, rawSecretKey: string): string {
  // Normalize escaped newlines from environment variables
  const secretKey = (rawSecretKey || '').replace(/\\n/g, '\n').trim();
  const isPem = secretKey.includes('-----BEGIN');

  if (isPem) {
    try {
      // 1. Try Ed25519 first (Moomoo's default & recommended algorithm)
      // In Node.js, Ed25519 digest algorithm must be null
      const sig = crypto.sign(null, Buffer.from(signingString, 'utf8'), secretKey);
      return sig.toString('base64');
    } catch {
      // 2. If Ed25519 failed, try RSA-SHA256
      try {
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(signingString, 'utf8');
        return signer.sign(secretKey, 'base64');
      } catch {
        // 3. Fallback to crypto.sign with sha256
        return crypto.sign('sha256', Buffer.from(signingString, 'utf8'), secretKey).toString('base64');
      }
    }
  }

  // Fallback to HMAC-SHA256 if standard secret string
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(signingString, 'utf8');
  return hmac.digest('base64');
}

export async function callMoomooApi<T = unknown>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    params?: Record<string, string | number | boolean>;
    body?: Record<string, unknown>;
    config?: MoomooConfig;
  } = {}
): Promise<{ success: boolean; data?: T; error?: string; status?: number }> {
  const config = options.config || getMoomooConfig();
  if (!config) {
    return {
      success: false,
      error: 'Moomoo API credentials not configured. Please set MOOMOO_API_KEY and MOOMOO_SECRET_KEY in environment.',
      status: 401,
    };
  }

  const method = options.method || 'GET';
  const queryEntries = Object.entries(options.params || {}).map(([k, v]) => [k, String(v)]);
  const queryString = queryEntries.length > 0 ? new URLSearchParams(queryEntries).toString() : '';
  const bodyString = options.body ? JSON.stringify(options.body) : '';

  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).substring(2);

  const signingString = buildMoomooSignatureString({
    timestamp,
    method,
    path,
    queryString,
    body: bodyString,
  });

  let signature: string;
  try {
    signature = signMoomooRequest(signingString, config.secretKey);
  } catch (signErr) {
    const msg = signErr instanceof Error ? signErr.message : 'Signature calculation failed';
    return {
      success: false,
      error: `Failed to sign request with MOOMOO_SECRET_KEY: ${msg}`,
      status: 400,
    };
  }

  const fullUrl = `${config.baseUrl}${path}${queryString ? `?${queryString}` : ''}`;

  const headers: Record<string, string> = {
    'X-Api-Key': config.apiKey,
    'Authorization': signature,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'Accept': 'application/json',
  };

  if (bodyString) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const fetchOptions: RequestInit = {
      method,
      headers,
      body: bodyString || undefined,
      signal: AbortSignal.timeout(15000),
    };

    const res = await fetch(fullUrl, fetchOptions);
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      const errMsg = json?.message || json?.error || `HTTP ${res.status} ${res.statusText}`;
      return {
        success: false,
        error: errMsg,
        status: res.status,
      };
    }

    return {
      success: true,
      data: (json?.data || json) as T,
      status: res.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to connect to Moomoo WebAPI';
    return {
      success: false,
      error: msg,
      status: 502,
    };
  }
}
