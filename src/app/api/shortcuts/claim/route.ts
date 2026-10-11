import { NextResponse } from 'next/server';
import {
  acknowledgeShortcutDraft,
  claimShortcutDraft,
} from '@/lib/shortcut-draft-store';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const ackId = (searchParams.get('ack') || '').trim();
    if (ackId) {
      const removed = acknowledgeShortcutDraft(ackId);
      return NextResponse.json(
        { success: true, removed },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const id = (searchParams.get('id') || 'latest').trim();
    const draft = claimShortcutDraft(id, Date.now(), false);

    if (!draft) {
      return NextResponse.json(
        {
          success: false,
          error: 'Quick draft not found or expired (drafts expire after 15 minutes).',
        },
        {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    return NextResponse.json(
      {
        success: true,
        draft,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch {
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve quick draft.' },
      { status: 500 }
    );
  }
}
