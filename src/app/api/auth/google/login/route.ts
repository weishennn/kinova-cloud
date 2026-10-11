import { NextRequest, NextResponse } from 'next/server';
import { getGoogleOAuthConfig } from '@/lib/google-auth';

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const { clientId, redirectUri } = getGoogleOAuthConfig(origin);

  if (!clientId) {
    return NextResponse.json(
      { error: 'GOOGLE_CLIENT_ID is not configured on the server.' },
      { status: 500 }
    );
  }

  const returnTo = req.nextUrl.searchParams.get('returnTo') || '/';
  const statePayload = Buffer.from(JSON.stringify({ returnTo, t: Date.now() }), 'utf8').toString('base64url');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set(
    'scope',
    'openid email profile https://www.googleapis.com/auth/drive.file'
  );
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent select_account');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', statePayload);

  return NextResponse.redirect(authUrl.toString());
}
