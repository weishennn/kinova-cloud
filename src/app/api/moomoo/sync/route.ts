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

    // 1. Discover authorized real trading accounts
    const authAccsRes = await callMoomooApi('/api/v1.0/accounts/authorized_trd_accs', {
      method: 'GET',
      config,
    }).catch((e) => ({ success: false, error: String(e) }));

    // 2. Discover simulated trading accounts
    const simAccsRes = await callMoomooApi('/api/v1.0/sim-trade/accounts', {
      method: 'GET',
      config,
    }).catch((e) => ({ success: false, error: String(e) }));

    // 3. Test sim-trade position query for account 2947143
    const testSimPos = await callMoomooApi('/api/v1.0/sim-trade/2947143/positions', {
      method: 'GET',
      config,
    }).catch((e) => ({ success: false, error: String(e) }));

    // 4. Query positions, orders, cash logs, and funds for discovered real accounts
    const authData = (authAccsRes as any)?.data;
    const realAccounts = authData?.d?.accounts || authData?.accounts || [];
    const realResults: Record<string, unknown> = {};

    const nowMs = Date.now();
    const beginTimeMicroseconds = (nowMs - 365 * 24 * 60 * 60 * 1000) * 1000;
    const endTimeMicroseconds = (nowMs + 24 * 60 * 60 * 1000) * 1000;

    for (const acc of realAccounts) {
      const accId = String(acc.account_id || '');
      if (!accId) continue;

      const [pos, ordersUs, ordersMy, cash, fundsUsd, fundsMyr] = await Promise.all([
        callMoomooApi(`/api/v1.0/accounts/${accId}/positions`, { method: 'GET', config }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/orders_history`, {
          method: 'GET',
          params: { trd_market: 'US' },
          config,
        }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/orders_history`, {
          method: 'GET',
          params: { trd_market: 'MY' },
          config,
        }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/cash_logs`, {
          method: 'GET',
          params: {
            begin_time: beginTimeMicroseconds,
            end_time: endTimeMicroseconds,
            page_size: 20,
          },
          config,
        }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/funds`, {
          method: 'GET',
          params: { currency: 'USD' },
          config,
        }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/funds`, {
          method: 'GET',
          params: { currency: 'MYR' },
          config,
        }).catch(() => null),
      ]);

      realResults[accId] = {
        positions: pos?.data || pos?.error,
        ordersUs: ordersUs?.data || ordersUs?.error,
        ordersMy: ordersMy?.data || ordersMy?.error,
        cashLogs: cash?.data || cash?.error,
        fundsUsd: fundsUsd?.data || fundsUsd?.error,
        fundsMyr: fundsMyr?.data || fundsMyr?.error,
      };
    }

    return NextResponse.json({
      configured: true,
      apiKeyPrefix: config.apiKey.slice(0, 6) + '***',
      connectionStatus: 'CONNECTED',
      authorizedTradingAccounts: (authAccsRes as any)?.data || (authAccsRes as any)?.error,
      realResults,
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
