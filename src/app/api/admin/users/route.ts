import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail, getValidGoogleSession, setSessionCookie } from '@/lib/google-auth';
import {
  getAdminUserRegistry,
  removeUserFromRegistry,
  setUserBlockStatus,
  toPublicUserList,
} from '@/lib/admin-registry';

export async function GET(req: NextRequest) {
  const { session, refreshed } = await getValidGoogleSession(req);
  if (!session || !session.isAdmin) {
    return NextResponse.json(
      { success: false, message: 'Forbidden: Administrator access required.' },
      { status: 403 }
    );
  }

  const registry = await getAdminUserRegistry(true);
  const res = NextResponse.json({
    success: true,
    adminEmail: getAdminEmail(),
    users: toPublicUserList(registry),
  });

  if (refreshed) {
    setSessionCookie(res, session);
  }
  return res;
}

export async function POST(req: NextRequest) {
  const { session, refreshed } = await getValidGoogleSession(req);
  if (!session || !session.isAdmin) {
    return NextResponse.json(
      { success: false, message: 'Forbidden: Administrator access required.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const action = String(body.action || '').trim();
    const email = String(body.email || '').trim().toLowerCase();

    if (!email) {
      return NextResponse.json(
        { success: false, message: 'Email is required.' },
        { status: 400 }
      );
    }

    if (action === 'block') {
      const updated = await setUserBlockStatus(email, true, body.reason);
      const registry = await getAdminUserRegistry(false);
      const res = NextResponse.json({
        success: true,
        user: updated,
        users: toPublicUserList(registry),
      });
      if (refreshed) setSessionCookie(res, session);
      return res;
    }

    if (action === 'unblock') {
      const updated = await setUserBlockStatus(email, false);
      const registry = await getAdminUserRegistry(false);
      const res = NextResponse.json({
        success: true,
        user: updated,
        users: toPublicUserList(registry),
      });
      if (refreshed) setSessionCookie(res, session);
      return res;
    }

    if (action === 'remove') {
      await removeUserFromRegistry(email);
      const registry = await getAdminUserRegistry(false);
      const res = NextResponse.json({
        success: true,
        users: toPublicUserList(registry),
      });
      if (refreshed) setSessionCookie(res, session);
      return res;
    }

    return NextResponse.json(
      { success: false, message: `Unknown admin action: ${action}` },
      { status: 400 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
}
