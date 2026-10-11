import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/google-auth';
import { setActiveShortcutOwner } from '@/lib/admin-registry';

export async function POST(req: Request) {
  await setActiveShortcutOwner('', req.headers.get('user-agent'));
  const res = NextResponse.json({ success: true });
  clearSessionCookie(res);
  return res;
}

export async function GET(req: Request) {
  await setActiveShortcutOwner('', req.headers.get('user-agent'));
  const url = new URL(req.url);
  const res = NextResponse.redirect(`${url.origin}/`);
  clearSessionCookie(res);
  return res;
}
