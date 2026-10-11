import { NextRequest, NextResponse } from 'next/server';
import {
  getGoogleOAuthConfig,
  GoogleUserSession,
  isAdminEmail,
  setSessionCookie,
} from '@/lib/google-auth';
import {
  getAdminUserRegistry,
  recordUserLogin,
  resolveAdminSpreadsheetId,
  setActiveShortcutOwner,
} from '@/lib/admin-registry';
import { ensureUserWorkspace } from '@/lib/google-sheets-user-engine';

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');
  const stateRaw = req.nextUrl.searchParams.get('state') || '';

  let returnTo = '/';
  if (stateRaw) {
    try {
      const decoded = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
      if (decoded?.returnTo && String(decoded.returnTo).startsWith('/')) {
        returnTo = String(decoded.returnTo);
      }
    } catch {}
  }

  if (error || !code) {
    return NextResponse.redirect(`${origin}/?auth_error=${encodeURIComponent(error || 'missing_code')}`);
  }

  const { clientId, clientSecret, redirectUri } = getGoogleOAuthConfig(origin);
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${origin}/?auth_error=oauth_not_configured`);
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
      cache: 'no-store',
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[GoogleCallback] Token exchange failed:', errText);
      return NextResponse.redirect(`${origin}/?auth_error=token_exchange_failed`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = String(tokenData.access_token || '');
    const expiresInSec = Number(tokenData.expires_in) || 3500;
    let refreshToken = tokenData.refresh_token ? String(tokenData.refresh_token) : undefined;

    // Fetch Google user profile
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });

    if (!userRes.ok) {
      return NextResponse.redirect(`${origin}/?auth_error=userinfo_failed`);
    }

    const userInfo = await userRes.json();
    const email = String(userInfo.email || '').trim().toLowerCase();
    const name = String(userInfo.name || email.split('@')[0]);
    const picture = userInfo.picture ? String(userInfo.picture) : undefined;

    if (!email) {
      return NextResponse.redirect(`${origin}/?auth_error=no_email`);
    }

    const isAdmin = isAdminEmail(email);

    // Check existing registry entry (for saved refreshToken / spreadsheetId / blacklist status)
    const registry = await getAdminUserRegistry(true);
    const existingEntry = registry[email];

    if (!refreshToken && existingEntry?.refreshToken) {
      refreshToken = existingEntry.refreshToken;
    }

    const session: GoogleUserSession = {
      email,
      name,
      picture,
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresInSec * 1000,
      spreadsheetId: isAdmin ? resolveAdminSpreadsheetId() : existingEntry?.spreadsheetId,
      invoicesFolderId: existingEntry?.invoicesFolderId,
      backupsFolderId: existingEntry?.backupsFolderId,
      isAdmin,
    };

    // If user is not blocked and not admin, auto-provision / locate their Google Sheet & Drive folders immediately
    if (!isAdmin && existingEntry?.status !== 'blocked') {
      try {
        const ws = await ensureUserWorkspace(session);
        session.spreadsheetId = ws.spreadsheetId;
        session.invoicesFolderId = ws.invoicesFolderId;
        session.backupsFolderId = ws.backupsFolderId;
      } catch (provErr) {
        console.warn('[GoogleCallback] Workspace auto-provision notice:', provErr);
      }
    }

    // Record login in Admin Registry
    const recordedUser = await recordUserLogin({
      email,
      name,
      picture,
      refreshToken,
      spreadsheetId: session.spreadsheetId,
      invoicesFolderId: session.invoicesFolderId,
      backupsFolderId: session.backupsFolderId,
    });

    if (recordedUser.status !== 'blocked' || isAdmin) {
      await setActiveShortcutOwner(email, req.headers.get('user-agent'));
    }

    const redirectTarget =
      recordedUser.status === 'blocked' && !isAdmin
        ? `${origin}/?auth_error=account_blocked`
        : `${origin}${returnTo}`;

    const res = NextResponse.redirect(redirectTarget);
    setSessionCookie(res, session);
    return res;
  } catch (err) {
    console.error('[GoogleCallback] Error:', err);
    return NextResponse.redirect(`${origin}/?auth_error=callback_exception`);
  }
}
