import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession, setSessionCookie } from '@/lib/google-auth';
import { getAdminAppsScriptEndpoint, isUserBlocked } from '@/lib/admin-registry';
import { executeUserGoogleAction } from '@/lib/google-sheets-user-engine';

const SERVER_TIMEOUT_MS = 25000;

async function fetchAppsScript(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

function hasValidAdminProxyToken(req: NextRequest): boolean {
  const provided = (req.headers.get('x-cashflow-proxy-token') || '').trim();
  const expected = (process.env.CASHFLOW_PROXY_TOKEN || '').trim();
  return Boolean(provided && expected && provided === expected);
}

export async function GET(req: NextRequest) {
  const { session, refreshed } = await getValidGoogleSession(req);

  if (session) {
    const blocked = await isUserBlocked(session.email);
    if (blocked) {
      return NextResponse.json(
        { success: false, blocked: true, message: 'Your account access has been restricted by the administrator.' },
        { status: 403 }
      );
    }

    // Non-admin Google users always read/write their own personal Google Drive
    if (!session.isAdmin) {
      try {
        const cookieHadSheetId = Boolean(session.spreadsheetId);
        const headerSheetId = (req.headers.get('x-kinova-spreadsheet-id') || '').trim();
        if (!session.spreadsheetId && headerSheetId) {
          session.spreadsheetId = headerSheetId;
        }
        const action = req.nextUrl.searchParams.get('action') || 'ping';
        const params: Record<string, unknown> = {};
        req.nextUrl.searchParams.forEach((val, key) => {
          params[key] = val;
        });
        const { result, sessionChanged } = await executeUserGoogleAction(session, action, params);
        const res = NextResponse.json({
          success: true,
          data: result,
          _proxy: {
            proxied: true,
            mode: 'google_oauth_user_drive',
            userEmail: session.email,
            spreadsheetId: session.spreadsheetId,
          },
        });
        if (!cookieHadSheetId || refreshed || sessionChanged || (headerSheetId && session.spreadsheetId !== headerSheetId)) {
          setSessionCookie(res, session);
        }
        return res;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, message }, { status: 500 });
      }
    }
  } else if (!hasValidAdminProxyToken(req)) {
    return NextResponse.json(
      { success: false, unauthenticated: true, message: 'Please sign in with your Google Account first.' },
      { status: 401 }
    );
  }

  // Admin account (or authenticated admin proxy token) routes to the owner's Apps Script ledger
  const endpoint = getAdminAppsScriptEndpoint();
  if (!endpoint) {
    if (session) {
      try {
        const action = req.nextUrl.searchParams.get('action') || 'ping';
        const params: Record<string, unknown> = {};
        req.nextUrl.searchParams.forEach((val, key) => {
          params[key] = val;
        });
        const { result, sessionChanged } = await executeUserGoogleAction(session, action, params);
        const res = NextResponse.json({ success: true, data: result });
        if (refreshed || sessionChanged) setSessionCookie(res, session);
        return res;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, message }, { status: 500 });
      }
    }
    return NextResponse.json(
      { success: false, message: 'Google Apps Script URL is not configured.' },
      { status: 503 }
    );
  }

  const { targetUrl, apiKey } = endpoint;

  try {
    const upstreamUrl = new URL(targetUrl);
    req.nextUrl.searchParams.forEach((val, key) => {
      if (key === 'apiKey') return;
      upstreamUrl.searchParams.set(key, val);
    });
    if (apiKey) {
      upstreamUrl.searchParams.set('apiKey', apiKey);
      if (!upstreamUrl.searchParams.has('key')) {
        upstreamUrl.searchParams.set('key', apiKey);
      }
    }

    const res = await fetchAppsScript(upstreamUrl.toString(), { method: 'GET' });
    if (!res.ok) {
      return NextResponse.json(
        { success: false, message: `Upstream Apps Script HTTP ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const response = NextResponse.json({
      ...data,
      _proxy: {
        proxied: true,
        serverAuthEnforced: true,
        serverKeyInjected: true,
        mode: 'admin_apps_script',
      },
    });
    if (session && refreshed) {
      setSessionCookie(response, session);
    }
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, message: `Server proxy GET error: ${message}` },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  const { session, refreshed } = await getValidGoogleSession(req);

  if (session) {
    const blocked = await isUserBlocked(session.email);
    if (blocked) {
      return NextResponse.json(
        { success: false, blocked: true, message: 'Your account access has been restricted by the administrator.' },
        { status: 403 }
      );
    }

    // Non-admin Google users always read/write their own personal Google Drive
    if (!session.isAdmin) {
      try {
        const cookieHadSheetId = Boolean(session.spreadsheetId);
        const headerSheetId = (req.headers.get('x-kinova-spreadsheet-id') || '').trim();
        if (!session.spreadsheetId && headerSheetId) {
          session.spreadsheetId = headerSheetId;
        }
        const body = await req.json();
        const action = String(body.action || req.nextUrl.searchParams.get('action') || '');
        const { result, sessionChanged } = await executeUserGoogleAction(session, action, body);
        const res = NextResponse.json({
          success: true,
          data: result,
          _proxy: {
            proxied: true,
            mode: 'google_oauth_user_drive',
            userEmail: session.email,
            spreadsheetId: session.spreadsheetId,
          },
        });
        if (!cookieHadSheetId || refreshed || sessionChanged || (headerSheetId && session.spreadsheetId !== headerSheetId)) {
          setSessionCookie(res, session);
        }
        return res;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, message }, { status: 500 });
      }
    }
  } else if (!hasValidAdminProxyToken(req)) {
    return NextResponse.json(
      { success: false, unauthenticated: true, message: 'Please sign in with your Google Account first.' },
      { status: 401 }
    );
  }

  const endpoint = getAdminAppsScriptEndpoint();
  if (!endpoint) {
    if (session) {
      try {
        const body = await req.json();
        const action = String(body.action || req.nextUrl.searchParams.get('action') || '');
        const { result, sessionChanged } = await executeUserGoogleAction(session, action, body);
        const res = NextResponse.json({ success: true, data: result });
        if (refreshed || sessionChanged) setSessionCookie(res, session);
        return res;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ success: false, message }, { status: 500 });
      }
    }
    return NextResponse.json(
      { success: false, message: 'Google Apps Script URL is not configured.' },
      { status: 503 }
    );
  }

  const { targetUrl, apiKey } = endpoint;

  try {
    const body = await req.json();
    const upstreamUrl = new URL(targetUrl);
    if (apiKey) {
      upstreamUrl.searchParams.set('apiKey', apiKey);
    }
    const payload = {
      key: apiKey,
      ...body,
      apiKey,
    };

    const res = await fetchAppsScript(upstreamUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return NextResponse.json(
        { success: false, message: `Upstream Apps Script HTTP ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const response = NextResponse.json({
      ...data,
      _proxy: {
        proxied: true,
        serverAuthEnforced: true,
        serverKeyInjected: true,
        mode: 'admin_apps_script',
      },
    });
    if (session && refreshed) {
      setSessionCookie(response, session);
    }
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, message: `Server proxy POST error: ${message}` },
      { status: 502 }
    );
  }
}
