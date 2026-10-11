import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/google-auth';

export async function POST() {
  const res = NextResponse.json({ success: true });
  clearSessionCookie(res);
  return res;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const res = NextResponse.redirect(`${url.origin}/`);
  clearSessionCookie(res);
  return res;
}
