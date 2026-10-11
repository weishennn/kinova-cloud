import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'direct';
  const ua = request.headers.get('user-agent') || 'unknown';
  const isMobile = /iPhone|iPad|Android/i.test(ua);
  
  if (isMobile || !request.nextUrl.pathname.startsWith('/_next/static/media')) {
    console.log(`[HTTP ${request.method}] ${request.nextUrl.pathname} (Mobile: ${isMobile})`);
  }

  const response = NextResponse.next();
  // Prevent mobile browsers from caching HTML pages or dev chunks and getting stuck on stale/403 responses
  if (process.env.NODE_ENV !== 'production' || !request.nextUrl.pathname.startsWith('/_next/static')) {
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Expires', '0');
  }
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/image|favicon.ico).*)',
  ],
};
