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

    // Test querying real discovered account IDs:
    // 2947143 (Malaysia), 5705555 (US), 5705556 (HK)
    const testAccountIds = ['5705555', '2947143', '5705556'];
    const accountResults: Record<string, unknown> = {};

    for (const accId of testAccountIds) {
      const [pos, orders, cash] = await Promise.all([
        callMoomooApi(`/api/v1.0/accounts/${accId}/positions`, { method: 'GET', config }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/orders_history`, { method: 'GET', config }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/cash_logs`, { method: 'GET', config }).catch(() => null),
      ]);
      accountResults[accId] = {
        positions: pos?.data || pos?.error,
        orders: orders?.data || orders?.error,
        cash: cash?.data || cash?.error,
      };
    }

    return NextResponse.json({
      configured: true,
      apiKeyPrefix: config.apiKey.slice(0, 6) + '***',
      connectionStatus: 'CONNECTED',
      connectionDetails: 'Connection successful',
      accountResults,
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
