import { NextRequest, NextResponse } from 'next/server';
import { getValidGoogleSession, setSessionCookie } from '@/lib/google-auth';
import { getBinanceConfig, callBinanceSigned } from '@/lib/binance-client';
import {
  fetchBinanceEquityQuotes,
  fetchBinanceTickers24h,
  fetchServerUsdToMyr,
  fetchTokenizedEquityMap,
  readStoredBinanceLedger,
  saveStoredBinanceLedger,
} from '@/lib/binance-cloud-store';
import {
  computeBinanceAnalytics,
  createEmptyBinanceLedger,
  extractWalletUsdValuations,
  mergeSpotAndFundingBalances,
  resolveAssetPriceUsd,
} from '@/lib/binance-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type SpotAccountResp = {
  balances?: Array<{ asset?: string; free?: string; locked?: string }>;
};

type FundingAssetRow = {
  asset?: string;
  free?: string;
  locked?: string;
  freeze?: string;
  withdrawing?: string;
};

type WalletBalanceRow = {
  walletName?: string;
  activate?: boolean;
  assetBalances?: Array<{
    asset?: string;
    free?: string;
    locked?: string;
    freeze?: string;
    withdrawing?: string;
  }>;
};

export async function GET(req: NextRequest) {
  try {
    const { session, refreshed } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized. Please sign in first.' }, { status: 401 });
    }
    if (!session.isAdmin) {
      return NextResponse.json(
        { success: false, error: 'Binance portfolio access is restricted to the workspace owner.' },
        { status: 403 }
      );
    }

    const config = getBinanceConfig();
    if (!config) {
      return NextResponse.json({
        success: true,
        configured: false,
        proxyEnabled: Boolean((process.env.FIXIE_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()),
        error: 'BINANCE_API_KEY and BINANCE_PRIVATE_KEY are not configured on the server.',
      });
    }

    const fresh = req.nextUrl.searchParams.get('fresh') === '1';

    const [spotRes, fundingRes, walletRes, tickerMap, tokenizedMap, usdToMyr, storedLedger] = await Promise.all([
      callBinanceSigned<SpotAccountResp>('/api/v3/account', {
        method: 'GET',
        params: { omitZeroBalances: 'true' },
        config,
      }),
      callBinanceSigned<FundingAssetRow[]>('/sapi/v1/asset/get-funding-asset', {
        method: 'POST',
        params: { needBtcValuation: 'false' },
        config,
      }),
      callBinanceSigned<WalletBalanceRow[]>('/sapi/v1/asset/wallet/balance', {
        method: 'GET',
        params: { needBalanceDetail: 'true', quoteAsset: 'USDT' },
        config,
      }),
      fetchBinanceTickers24h(config, fresh),
      fetchTokenizedEquityMap(config),
      fetchServerUsdToMyr(),
      readStoredBinanceLedger(session).catch(() => null),
    ]);

    if (!spotRes.success) {
      return NextResponse.json(
        {
          success: false,
          configured: true,
          proxyEnabled: Boolean(config.proxyUrl),
          keyType: config.keyType,
          error: spotRes.error || 'Failed to load Binance Spot account.',
        },
        { status: spotRes.status && spotRes.status >= 400 ? spotRes.status : 502 }
      );
    }

    const warnings: string[] = [];
    if (!fundingRes.success) {
      warnings.push(`Funding wallet read warning: ${fundingRes.error || 'Unavailable'}`);
    }
    if (!walletRes.success) {
      warnings.push(`All-wallets read warning: ${walletRes.error || 'Unavailable'}`);
    }

    const walletRows = walletRes.success && Array.isArray(walletRes.data) ? walletRes.data : [];
    const balances = mergeSpotAndFundingBalances(
      spotRes.data?.balances || [],
      fundingRes.success && Array.isArray(fundingRes.data) ? fundingRes.data : [],
      walletRows
    );

    const btcPriceUsd = resolveAssetPriceUsd('BTC', tickerMap).priceUsd;
    const fallbackUsdPriceMap = extractWalletUsdValuations(walletRows, btcPriceUsd);

    const ledger = storedLedger || createEmptyBinanceLedger();
    const effectiveTokenizedMap = {
      ...(ledger.tokenizedAssetMap || {}),
      ...tokenizedMap,
    };

    const equitySymbols = new Set<string>();
    for (const b of balances) {
      if (effectiveTokenizedMap[b.asset]) {
        equitySymbols.add(effectiveTokenizedMap[b.asset]);
      } else if ((b.equityQty || 0) > 0) {
        equitySymbols.add(b.asset);
      } else if (b.asset.length >= 3 && (b.asset.endsWith('ON') || b.asset.endsWith('B'))) {
        equitySymbols.add(b.asset.replace(/(ON|B)$/, ''));
      }
    }
    for (const tr of ledger.trades) {
      if (tr.source === 'equity') equitySymbols.add(tr.baseAsset);
    }
    const equityPrices = await fetchBinanceEquityQuotes([...equitySymbols], config);

    const analytics = computeBinanceAnalytics({
      balances,
      trades: ledger.trades,
      fundingEvents: ledger.fundingEvents,
      tickerMap,
      usdToMyr,
      costBasisOverrides: ledger.costBasisOverrides,
      equityPrices,
      tokenizedAssetMap: effectiveTokenizedMap,
      equityNetAdjustment: ledger.equityNetAdjustment || {},
      fallbackUsdPriceMap,
    });

    const response = NextResponse.json({
      success: true,
      configured: true,
      proxyEnabled: Boolean(config.proxyUrl),
      keyType: config.keyType,
      usdToMyr,
      lastSyncAt: ledger.lastSyncAt || null,
      hasSyncedHistory: ledger.lastHistorySyncMs > 0 || ledger.trades.length > 0 || ledger.fundingEvents.length > 0,
      balances,
      analytics,
      ledger: {
        trades: ledger.trades,
        fundingEvents: ledger.fundingEvents,
        costBasisOverrides: ledger.costBasisOverrides,
        customSymbols: ledger.customSymbols,
      },
      warnings,
      diagnostics: {
        wallets: walletRows.map((w) => String(w.walletName || '')).filter(Boolean),
        spotCount: (spotRes.data?.balances || []).length,
        fundingCount: fundingRes.success && Array.isArray(fundingRes.data) ? fundingRes.data.length : 0,
        equityTradesCount: ledger.trades.filter((t) => t.source === 'equity').length,
      },
      usedWeight1m: spotRes.usedWeight1m,
      fetchedAt: new Date().toISOString(),
    });

    if (refreshed) setSessionCookie(response, session);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load Binance portfolio.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { session, refreshed } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized.' }, { status: 401 });
    }
    if (!session.isAdmin) {
      return NextResponse.json({ success: false, error: 'Forbidden.' }, { status: 403 });
    }

    const body = (await req.json()) as {
      costBasisOverrides?: Record<string, number>;
      customSymbols?: string[];
    };

    const ledger = (await readStoredBinanceLedger(session)) || createEmptyBinanceLedger();

    if (body.costBasisOverrides && typeof body.costBasisOverrides === 'object') {
      const cleaned: Record<string, number> = { ...ledger.costBasisOverrides };
      for (const [eventId, rawVal] of Object.entries(body.costBasisOverrides)) {
        if (rawVal === null || rawVal === undefined || Number.isNaN(Number(rawVal)) || Number(rawVal) < 0) {
          delete cleaned[eventId];
        } else {
          cleaned[eventId] = Number(rawVal);
        }
      }
      ledger.costBasisOverrides = cleaned;
    }

    if (Array.isArray(body.customSymbols)) {
      ledger.customSymbols = [
        ...new Set(
          body.customSymbols
            .map((s) => String(s).trim().toUpperCase())
            .filter((s) => /^[A-Z0-9]{4,16}$/.test(s))
        ),
      ];
    }

    await saveStoredBinanceLedger(session, ledger);

    const response = NextResponse.json({
      success: true,
      costBasisOverrides: ledger.costBasisOverrides,
      customSymbols: ledger.customSymbols,
    });
    if (refreshed) setSessionCookie(response, session);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update Binance preferences.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
