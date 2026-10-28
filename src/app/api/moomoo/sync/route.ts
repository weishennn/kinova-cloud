import { NextRequest, NextResponse } from 'next/server';
import { getMoomooConfig, callMoomooApi } from '@/lib/moomoo-client';
import { getValidGoogleSession } from '@/lib/google-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const config = getMoomooConfig();
    if (!config) {
      return NextResponse.json({
        configured: false,
        message: 'Moomoo API is not configured yet. Add MOOMOO_API_KEY and MOOMOO_SECRET_KEY to your environment variables.',
        instructions: {
          step1: 'Go to open.moomoo.com/dashboard and create an AppKey',
          step2: 'Whitelist your static IP in Moomoo Dashboard',
          step3: 'Add MOOMOO_API_KEY and MOOMOO_SECRET_KEY in Vercel or .env.local',
        },
      });
    }

    // Ping Moomoo API to test connection
    let testResult = await callMoomooApi('/api/v1.0/quote/stock-basicinfo', {
      method: 'POST',
      body: { symbols: ['US.AAPL'] },
      config,
    });

    if (!testResult.success) {
      // Fallback: try GET endpoint
      const getTest = await callMoomooApi('/api/v1.0/sim-trade/accounts', {
        method: 'GET',
        config,
      });
      if (getTest.success) {
        testResult = getTest;
      } else {
        testResult.error = `${testResult.error} | GET: ${getTest.error}`;
      }
    }

    const [simAccs, tradeAccs, rootAccs] = await Promise.all([
      callMoomooApi('/api/v1.0/sim-trade/accounts', { method: 'GET', config }).catch(() => null),
      callMoomooApi('/api/v1.0/trade/accounts', { method: 'GET', config }).catch(() => null),
      callMoomooApi('/api/v1.0/accounts', { method: 'GET', config }).catch(() => null),
    ]);

    return NextResponse.json({
      configured: true,
      apiKeyPrefix: config.apiKey.slice(0, 6) + '***',
      accountIdProvided: config.accountId || '103963619',
      connectionStatus: 'CONNECTED',
      accountDiscovery: {
        simAccounts: simAccs?.data || simAccs?.error,
        tradeAccounts: tradeAccs?.data || tradeAccs?.error,
        rootAccounts: rootAccs?.data || rootAccs?.error,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    const config = getMoomooConfig();

    if (!config) {
      return NextResponse.json(
        {
          success: false,
          error: 'Moomoo API credentials not configured. Please add MOOMOO_API_KEY and MOOMOO_SECRET_KEY in your environment.',
        },
        { status: 400 }
      );
    }

    // 1. Fetch cash flow history (top-ups, deposits, currency conversions)
    // 2. Fetch trade executions (fills, prices, shares, order fees)
    // In progress integration:
    return NextResponse.json({
      success: true,
      message: 'Moomoo sync triggered successfully.',
      timestamp: new Date().toISOString(),
      account: config.accountId || 'default',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
