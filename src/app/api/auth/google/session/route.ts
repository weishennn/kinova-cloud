import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession, setSessionCookie } from '@/lib/google-auth';
import { isUserBlocked } from '@/lib/admin-registry';
import { ensureUserWorkspace } from '@/lib/google-sheets-user-engine';

export async function GET(req: NextRequest) {
  const { session, refreshed } = await getValidGoogleSession(req);
  if (!session) {
    return NextResponse.json({
      authenticated: false,
      user: null,
    });
  }

  const blocked = await isUserBlocked(session.email);
  let workspaceChanged = false;

  if (!blocked && !session.isAdmin) {
    try {
      const ws = await ensureUserWorkspace(session);
      if (ws.changed || session.spreadsheetId !== ws.spreadsheetId) {
        session.spreadsheetId = ws.spreadsheetId;
        session.invoicesFolderId = ws.invoicesFolderId;
        session.backupsFolderId = ws.backupsFolderId;
        workspaceChanged = true;
      }
    } catch (err) {
      console.warn('[GoogleSession] Workspace init notice:', err);
    }
  }

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

  if (refreshed || workspaceChanged) {
    setSessionCookie(res, session);
  }

  return res;
}
