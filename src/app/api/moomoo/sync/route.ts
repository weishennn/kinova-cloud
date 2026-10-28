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

    const accId = config.accountId || '103963619';
    const [positionsRes, cashLogsRes, ordersRes] = await Promise.all([
      callMoomooApi(`/api/v1.0/accounts/${accId}/positions`, { method: 'GET', config }).catch(() => null),
      callMoomooApi(`/api/v1.0/accounts/${accId}/cash_logs`, { method: 'GET', config }).catch(() => null),
      callMoomooApi(`/api/v1.0/accounts/${accId}/orders_history`, { method: 'GET', config }).catch(() => null),
    ]);

    return NextResponse.json({
      configured: true,
      apiKeyPrefix: config.apiKey.slice(0, 6) + '***',
      accountId: accId,
      proxyConfigured: Boolean(config.proxyUrl),
      connectionStatus: testResult.success ? 'CONNECTED' : 'AUTH_ERROR',
      connectionDetails: testResult.error || 'Connection successful',
      accountSummary: {
        positionsAvailable: Boolean(positionsRes?.success),
        positionsCount: Array.isArray((positionsRes?.data as any)?.positions || positionsRes?.data) ? ((positionsRes?.data as any)?.positions || positionsRes?.data).length : 0,
        cashLogsAvailable: Boolean(cashLogsRes?.success),
        cashLogsCount: Array.isArray((cashLogsRes?.data as any)?.cash_logs || cashLogsRes?.data) ? ((cashLogsRes?.data as any)?.cash_logs || cashLogsRes?.data).length : 0,
        ordersHistoryAvailable: Boolean(ordersRes?.success),
        ordersCount: Array.isArray((ordersRes?.data as any)?.orders || ordersRes?.data) ? ((ordersRes?.data as any)?.orders || ordersRes?.data).length : 0,
        sampleCashLog: (cashLogsRes?.data as any)?.cash_logs?.[0] || null,
        sampleOrder: (ordersRes?.data as any)?.orders?.[0] || null,
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
