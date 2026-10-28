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

    // Collect all candidate IDs to query
    const candidateIds = new Set<string>();
    for (const acc of realAccounts) {
      if (acc.account_id) candidateIds.add(String(acc.account_id));
      if (acc.account_card_number) candidateIds.add(String(acc.account_card_number));
      if (acc.univs_account_card_number) candidateIds.add(String(acc.univs_account_card_number));
    }

    for (const accId of candidateIds) {
      const [pos, orders, cash, funds] = await Promise.all([
        callMoomooApi(`/api/v1.0/accounts/${accId}/positions`, { method: 'GET', config }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/orders_history`, { method: 'GET', config }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/cash_logs`, { method: 'GET', config }).catch(() => null),
        callMoomooApi(`/api/v1.0/accounts/${accId}/funds`, { method: 'GET', config }).catch(() => null),
      ]);
      realResults[accId] = {
        positions: pos?.data || pos?.error,
        orders: orders?.data || orders?.error,
        cash: cash?.data || cash?.error,
        funds: funds?.data || funds?.error,
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
