import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession, setSessionCookie } from '@/lib/google-auth';
import { isUserBlocked } from '@/lib/admin-registry';

export async function GET(req: NextRequest) {
  const { session, refreshed } = await getValidGoogleSession(req);
  if (!session) {
    return NextResponse.json({
      authenticated: false,
      user: null,
    });
  }

  const blocked = await isUserBlocked(session.email);

  const res = NextResponse.json({
    authenticated: !blocked,
    blocked,
    user: {
      email: session.email,
      name: session.name,
      picture: session.picture,
      isAdmin: session.isAdmin,
      spreadsheetId: session.spreadsheetId,
      spreadsheetUrl: session.spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${session.spreadsheetId}`
        : undefined,
    },
  });

  if (refreshed) {
    setSessionCookie(res, session);
  }

  return res;
}
