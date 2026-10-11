import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

export const GOOGLE_SESSION_COOKIE = 'kinova_google_session';

export interface GoogleUserSession {
  email: string;
  name: string;
  picture?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  spreadsheetId?: string;
  invoicesFolderId?: string;
  backupsFolderId?: string;
  isAdmin: boolean;
}

export function getGoogleOAuthConfig(reqOrigin?: string) {
  const clientId = (
    process.env.GOOGLE_CLIENT_ID ||
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
    '361395482195-g6sig5c9b4i82d0u1s8f8fs9gvmda445.apps.googleusercontent.com'
  ).trim();

  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const origin = (reqOrigin || process.env.NEXT_PUBLIC_APP_URL || 'https://kinova-gold.vercel.app').replace(/\/$/, '');
  const redirectUri = `${origin}/api/auth/google/callback`;

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

export function getAdminEmail(): string {
  return (process.env.ADMIN_EMAIL || 'weishenooi2003@gmail.com').trim().toLowerCase();
}

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return email.trim().toLowerCase() === getAdminEmail();
}

function getSecretKey(): Buffer {
  const rawSecret =
    process.env.AUTH_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET ||
    process.env.CASHFLOW_PROXY_TOKEN ||
    'kinova-multiuser-cookie-secret-key-2026';
  return crypto.createHash('sha256').update(rawSecret).digest();
}

export function encryptSession(session: GoogleUserSession): string {
  const key = getSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url');
}

export function decryptSession(token: string): GoogleUserSession | null {
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const key = getSecretKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString('utf8')) as GoogleUserSession;
    if (!parsed || !parsed.email) return null;
    parsed.isAdmin = isAdminEmail(parsed.email);
    return parsed;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: NextResponse, session: GoogleUserSession): void {
  const encoded = encryptSession(session);
  res.cookies.set(GOOGLE_SESSION_COOKIE, encoded, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(GOOGLE_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export function readSessionFromRequest(req: NextRequest): GoogleUserSession | null {
  const raw = req.cookies.get(GOOGLE_SESSION_COOKIE)?.value;
  if (!raw) return null;
  return decryptSession(raw);
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number;
} | null> {
  const { clientId, clientSecret } = getGoogleOAuthConfig();
  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;

    const expiresInSec = Number(data.expires_in) || 3500;
    return {
      accessToken: String(data.access_token),
      expiresAt: Date.now() + expiresInSec * 1000,
    };
  } catch {
    return null;
  }
}

/**
 * Reads the current user's Google session from the request and automatically refreshes
 * the access token if it has expired or is about to expire within 90 seconds.
 */
export async function getValidGoogleSession(req: NextRequest): Promise<{
  session: GoogleUserSession | null;
  refreshed: boolean;
}> {
  const session = readSessionFromRequest(req);
  if (!session) return { session: null, refreshed: false };

  const now = Date.now();
  if (session.accessToken && session.expiresAt && session.expiresAt - now > 90_000) {
    return { session, refreshed: false };
  }

  if (session.refreshToken) {
    const refreshedToken = await refreshGoogleAccessToken(session.refreshToken);
    if (refreshedToken) {
      const updated: GoogleUserSession = {
        ...session,
        accessToken: refreshedToken.accessToken,
        expiresAt: refreshedToken.expiresAt,
      };
      return { session: updated, refreshed: true };
    }
  }

  return { session, refreshed: false };
}
