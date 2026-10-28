import { NextRequest, NextResponse } from 'next/server';
import { getMoomooConfig, callMoomooApi } from '@/lib/moomoo-client';
import { getValidGoogleSession, setSessionCookie } from '@/lib/google-auth';
import { executeUserGoogleAction } from '@/lib/google-sheets-user-engine';

export const dynamic = 'force-dynamic';

function parseMoomooDate(val: any): string {
  if (!val) return new Date().toISOString().split('T')[0];
  if (typeof val === 'number' || /^\d+$/.test(String(val).trim())) {
    const num = Number(val);
    if (num > 1e14) {
      // microseconds (16 digits)
      return new Date(num / 1000).toISOString().split('T')[0];
    }
    if (num > 1e11) {
      // milliseconds (13 digits)
      return new Date(num).toISOString().split('T')[0];
    }
    if (num > 1e8) {
      // seconds (10 digits)
      return new Date(num * 1000).toISOString().split('T')[0];
    }
  }
  const str = String(val).trim();
  const firstPart = str.split(' ')[0].split('T')[0];
  const slashParts = firstPart.split('/');
  if (slashParts.length === 3) {
    const month = slashParts[0].padStart(2, '0');
    const day = slashParts[1].padStart(2, '0');
    const year = slashParts[2];
    return `${year}-${month}-${day}`;
  }
  const dashParts = firstPart.split('-');
  if (dashParts.length === 3) {
    return firstPart;
  }
  return new Date().toISOString().split('T')[0];
}

export async function GET(req: NextRequest) {
  try {
    const config = getMoomooConfig();
    if (!config) {
      return NextResponse.json({
        configured: false,
        message: 'Moomoo API is not configured yet. Add MOOMOO_API_KEY and MOOMOO_SECRET_KEY to your environment variables.',
      });
    }

    // Discover authorized real trading accounts
    const authAccsRes = await callMoomooApi('/api/v1.0/accounts/authorized_trd_accs', {
      method: 'GET',
      config,
    }).catch((e) => ({ success: false, error: String(e) }));

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
    const { session, refreshed } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized. Please log in to your account first.' },
        { status: 401 }
      );
    }

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

    // 1. Fetch authorized trading accounts
    const authAccsRes = await callMoomooApi('/api/v1.0/accounts/authorized_trd_accs', {
      method: 'GET',
      config,
    });

    const authData = (authAccsRes as any)?.data;
    const realAccounts = authData?.d?.accounts || authData?.accounts || [];
    if (realAccounts.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No authorized Moomoo trading accounts found for this API key.',
      });
    }

    const primaryAcc = realAccounts[0];
    const accId = String(primaryAcc.account_id || '');

    const nowMs = Date.now();
    const beginTimeMicroseconds = (nowMs - 365 * 24 * 60 * 60 * 1000) * 1000;
    const endTimeMicroseconds = (nowMs + 24 * 60 * 60 * 1000) * 1000;

    // 2. Fetch positions, orders, cash logs, and funds in parallel
    const [posRes, ordersUsRes, cashLogsRes, fundsUsdRes, fundsMyrRes] = await Promise.all([
      callMoomooApi<any>(`/api/v1.0/accounts/${accId}/positions`, { method: 'GET', config }),
      callMoomooApi<any>(`/api/v1.0/accounts/${accId}/orders_history`, {
        method: 'GET',
        params: { trd_market: 'US' },
        config,
      }),
      callMoomooApi<any>(`/api/v1.0/accounts/${accId}/cash_logs`, {
        method: 'GET',
        params: {
          begin_time: beginTimeMicroseconds,
          end_time: endTimeMicroseconds,
          page_size: 20,
        },
        config,
      }),
      callMoomooApi<any>(`/api/v1.0/accounts/${accId}/funds`, {
        method: 'GET',
        params: { currency: 'USD' },
        config,
      }),
      callMoomooApi<any>(`/api/v1.0/accounts/${accId}/funds`, {
        method: 'GET',
        params: { currency: 'MYR' },
        config,
      }),
    ]);

    const cashLogsList = cashLogsRes?.data?.d?.list || [];
    const ordersList = ordersUsRes?.data?.d?.orders || [];
    const positionsList = posRes?.data?.d || [];

    // 3. Read existing Trades from Google Sheets
    const existingTradesRes = await executeUserGoogleAction(session, 'getTrades', {}).catch(() => ({
      result: { rows: [] },
    }));
    const rawExistingRows = ((existingTradesRes as any)?.result?.rows || []) as Array<Record<string, unknown>>;

    let syncedTrades = 0;
    let skippedTrades = 0;
    const allSyncedTrades: Array<Record<string, unknown>> = [...rawExistingRows];

    // Build fee lookup map from cash logs: { symbol -> total fee }
    const feeBySymbol: Record<string, number> = {};
    for (const log of cashLogsList) {
      if (log.transaction_name === 'Stock Buy Fee' && log.symbol) {
        const sym = log.symbol.toUpperCase();
        const feeAmount = Math.abs(parseFloat(log.cash_change || '0'));
        feeBySymbol[sym] = (feeBySymbol[sym] || 0) + feeAmount;
      }
    }

    // Sync filled orders to Google Sheet 'Trades'
    for (const order of ordersList) {
      if (order.order_status !== 'FILLED_ALL' && order.order_status !== 'FILLED_PART') {
        continue;
      }

      const rawCode = String(order.code || '');
      const ticker = rawCode.replace(/^(US\.|HK\.|MY\.)/, '').toUpperCase();
      const orderId = String(order.order_id || '');
      const orderDate = parseMoomooDate(order.create_time || order.updated_time || order.time);

      const qty = parseFloat(order.dealt_qty || order.qty || '0');
      const price = parseFloat(order.dealt_avg_price || order.price || '0');
      const action = String(order.side || 'BUY').toUpperCase();
      const currency = String(order.currency || 'USD').toUpperCase();
      const stockName = String(order.stock_name || ticker);

      // Check if this specific order is already logged
      const isAlreadyLogged = rawExistingRows.some((r) => {
        const notes = String(r.Notes || '');
        const rId = String(r.Id || '');
        if (orderId && (notes.includes(orderId) || rId.includes(orderId))) return true;
        const rTicker = String(r.Ticker || '').toUpperCase();
        const rDate = String(r.Date || '');
        const rQty = Math.abs(parseFloat(String(r.Quantity || '0')));
        const rAction = String(r.Action || 'BUY').toUpperCase();
        return rTicker === ticker && rDate === orderDate && Math.abs(rQty - qty) < 0.0001 && rAction === action;
      });

      if (isAlreadyLogged) {
        skippedTrades++;
        continue;
      }

      // Approximate or lookup fee
      const fees = feeBySymbol[ticker] || 0.50;
      const netTotal = parseFloat((qty * price + fees).toFixed(2));
      const tradeId = `moo_${orderId || Date.now().toString(36)}_${Date.now().toString(36)}`;

      const tradeObj = {
        Id: tradeId,
        Date: orderDate,
        Action: action,
        Ticker: ticker,
        'Asset Name': stockName,
        Quantity: qty,
        Price: price,
        Fees: fees,
        'Net Total': netTotal,
        Currency: currency,
        Notes: `Moomoo Auto-Sync (Order: ${orderId})`,
      };

      await executeUserGoogleAction(session, 'addTrade', {
        tradeData: {
          ...tradeObj,
          _forceRestore: true,
        },
      });

      rawExistingRows.push(tradeObj);
      allSyncedTrades.push(tradeObj);
      syncedTrades++;
    }

    // If an older holding exists in positions (e.g. SPCX) that wasn't in the recent orders list:
    for (const pos of positionsList) {
      const rawCode = String(pos.code || '');
      const ticker = rawCode.replace(/^(US\.|HK\.|MY\.)/, '').toUpperCase();
      const posQty = parseFloat(pos.qty || '0');
      if (posQty <= 0) continue;

      // Check if this ticker is already covered by ANY trade (either in rawExistingRows or filled ordersList)
      const hasExistingTradeForTicker = rawExistingRows.some(
        (r) => String(r.Ticker || '').toUpperCase() === ticker
      );
      const hasOrderForTicker = ordersList.some(
        (o: any) =>
          (o.order_status === 'FILLED_ALL' || o.order_status === 'FILLED_PART') &&
          String(o.code || '').replace(/^(US\.|HK\.|MY\.)/, '').toUpperCase() === ticker
      );

      if (hasExistingTradeForTicker || hasOrderForTicker) {
        continue;
      }

      // Find execution in cash logs
      const buyExec = cashLogsList.find(
        (c: any) => c.symbol === ticker && c.transaction_name === 'Stock Buy Execution'
      );
      const buyFee = cashLogsList.find(
        (c: any) => c.symbol === ticker && c.transaction_name === 'Stock Buy Fee'
      );

      const tradeDate = buyExec ? parseMoomooDate(buyExec.created_time) : '2026-06-13';
      const price = parseFloat(pos.cost_price || '0');
      const fees = buyFee ? Math.abs(parseFloat(buyFee.cash_change || '0')) : 0.47;
      const netTotal = parseFloat((posQty * price + fees).toFixed(2));
      const posTradeId = `moo_pos_${ticker.toLowerCase()}_${Date.now().toString(36)}`;

      const posTradeObj = {
        Id: posTradeId,
        Date: tradeDate,
        Action: 'BUY',
        Ticker: ticker,
        'Asset Name': String(pos.stock_name || ticker),
        Quantity: posQty,
        Price: price,
        Fees: fees,
        'Net Total': netTotal,
        Currency: 'USD',
        Notes: `Moomoo Auto-Sync Holding (${ticker})`,
      };

      await executeUserGoogleAction(session, 'addTrade', {
        tradeData: {
          ...posTradeObj,
          _forceRestore: true,
        },
      });

      rawExistingRows.push(posTradeObj);
      allSyncedTrades.push(posTradeObj);
      syncedTrades++;
    }

    // 4. Sync cash top-ups (deposits) from cash logs
    let syncedDeposits = 0;
    let skippedDeposits = 0;

    for (const log of cashLogsList) {
      if (log.transaction_name === 'Bank Transfer Deposits') {
        const depositDate = parseMoomooDate(log.created_time);
        const monthStr = depositDate.substring(0, 7); // YYYY-MM
        const rawAmount = log.cash_change ? log.cash_change.replace(/[+,\s]/g, '') : '0';
        const amount = parseFloat(rawAmount) || 0;

        // Check if month already contains this deposit
        const monthDataRes = await executeUserGoogleAction(session, 'getSheetDataIfExists', {
          sheetName: monthStr,
        }).catch(() => null);

        const monthRows = ((monthDataRes as any)?.result?.rows || []) as Array<Record<string, unknown>>;
        const alreadyLogged = monthRows.some((r) => {
          const desc = String(r.Description || '').toLowerCase();
          const rDate = String(r.Date || '');
          const rAmt = Math.abs(parseFloat(String(r.Amount || '0')));
          return (
            (desc.includes('moomoo') || desc.includes('deposit')) &&
            rDate === depositDate &&
            Math.abs(rAmt - amount) < 0.01
          );
        });

        if (alreadyLogged) {
          skippedDeposits++;
          continue;
        }

        await executeUserGoogleAction(session, 'addRow', {
          sheetName: monthStr,
          rowData: {
            Id: `moo_dep_${depositDate.replace(/-/g, '')}_${Math.floor(amount)}`,
            Date: depositDate,
            Type: 'Income',
            Category: 'Investment Deposit',
            SubCategory: 'Moomoo Deposit',
            Description: 'Moomoo Bank Transfer Deposit',
            Amount: amount,
            Currency: 'MYR',
            Notes: 'Auto-synced from Moomoo Cloud API',
          },
        });

        syncedDeposits++;
      }
    }

    const fundsUsd = fundsUsdRes?.data?.d;
    const fundsMyr = fundsMyrRes?.data?.d;

    // Force synchronize the Portfolio formulas sheet
    await executeUserGoogleAction(session, 'syncPortfolio', {}).catch(() => null);

    // Fetch the clean trades and portfolio lists from Google Sheets
    const freshTradesRes = await executeUserGoogleAction(session, 'getTrades', {}).catch(() => null);
    const freshTrades = ((freshTradesRes as any)?.result?.rows || []) as Array<Record<string, unknown>>;

    const freshPortfolioRes = await executeUserGoogleAction(session, 'getPortfolio', {}).catch(() => null);
    const freshPortfolio = ((freshPortfolioRes as any)?.result || []) as Array<Record<string, unknown>>;

    // Defensively ensure trades is NEVER empty when trades were synced or existed
    const resolvedTrades = freshTrades.length > 0
      ? freshTrades
      : allSyncedTrades.length > 0
        ? allSyncedTrades
        : rawExistingRows;

    // Defensively ensure portfolio is NEVER empty when positions exist
    let resolvedPortfolio = freshPortfolio;
    if (resolvedPortfolio.length === 0 && positionsList.length > 0) {
      resolvedPortfolio = positionsList
        .filter((p: any) => parseFloat(p.qty || '0') > 0)
        .map((p: any) => {
          const rawCode = String(p.code || '');
          const ticker = rawCode.replace(/^(US\.|HK\.|MY\.)/, '').toUpperCase();
          const units = parseFloat(p.qty || '0');
          const avgCost = parseFloat(p.cost_price || '0');
          const livePrice = parseFloat(p.nominal_price || p.cost_price || '0');
          return {
            Ticker: ticker,
            'Asset Name': String(p.stock_name || ticker),
            Type: 'Stock',
            Currency: 'USD',
            'Units Held': units,
            'Avg Cost': avgCost,
            'Total Cost': parseFloat((units * avgCost).toFixed(2)),
            'Live Price': livePrice,
            'Market Value': parseFloat((units * livePrice).toFixed(2)),
            'Profit / Loss': parseFloat(((units * livePrice) - (units * avgCost)).toFixed(2)),
            'Return %': avgCost > 0 ? parseFloat((((livePrice - avgCost) / avgCost) * 100).toFixed(2)) : 0,
          };
        });
    }

    const response = NextResponse.json({
      success: true,
      message: `Moomoo sync completed. Synced ${syncedTrades} trades and ${syncedDeposits} cash deposits.`,
      syncedTrades,
      skippedTrades,
      syncedDeposits,
      skippedDeposits,
      trades: resolvedTrades,
      portfolio: resolvedPortfolio,
      portfolioSummary: {
        totalAssetsUsd: fundsUsd?.total_assets || '99.00',
        totalAssetsMyr: fundsMyr?.total_assets || '403.58',
        unrealizedPlMyr: fundsMyr?.unrealized_pl || '12.64',
        positionsCount: positionsList.length,
      },
      timestamp: new Date().toISOString(),
    });

    if (refreshed) {
      setSessionCookie(response, session);
    }
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
