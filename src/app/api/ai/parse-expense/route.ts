import { NextRequest, NextResponse } from 'next/server';
import { getLocalDateString, parseLocalDate } from '@/lib/date-helper';
import { getValidGoogleSession } from '@/lib/google-auth';
import { recordUserAiCall } from '@/lib/admin-registry';
import { getLoadBalancedGeminiKeys, reportGeminiKeyFailure } from '@/lib/gemini-key-pool';
import type {
  AiCommand,
  AiInstallmentData,
  AiTradeData,
  AiTransactionData,
  AiTripData,
} from '@/types/ai-command';

const VALID_CURRENCIES = new Set(['MYR', 'USD', 'SGD', 'EUR', 'GBP', 'JPY', 'AUD', 'IDR', 'THB', 'CNY', 'HKD']);
const VALID_TRANSACTION_TYPES = new Set(['Expense', 'Income', 'Investment']);
const VALID_TRADE_ACTIONS = new Set(['BUY', 'SELL', 'DIVIDEND', 'REINVEST']);

function sanitizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = parseLocalDate(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return getLocalDateString(parsed);
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && sanitizeDate(value) !== null;
}

function validCurrency(value: unknown): value is string {
  return typeof value === 'string' && VALID_CURRENCIES.has(value.toUpperCase());
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function optionalPositiveNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  return positiveNumber(value) ? value : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function tradeActionIsReinvest(value: unknown): boolean {
  return textValue(value).toUpperCase() === 'REINVEST';
}

function extractExplicitPercentRates(sourceText: string): number[] {
  if (!sourceText) return [];
  const results: number[] = [];
  const regexes = [
    /(\d+(?:\.\d+)?)\s*(?:%|percent\b|pct\b)/gi,
    /(\d+(?:\.\d+)?)\s*(?:p\.?a\.?\s*)?(?:interest|rate\b)/gi,
    /(?:interest|rate)\s*(?:of\s*|at\s*)?(\d+(?:\.\d+)?)/gi,
  ];
  for (const rx of regexes) {
    for (const match of sourceText.matchAll(rx)) {
      const val = parseFloat(match[1]);
      if (Number.isFinite(val) && val > 0 && val <= 100 && !results.some((r) => Math.abs(r - val) < 0.0001)) {
        results.push(val);
      }
    }
  }
  return results;
}

function normalizePercentageRate(
  value: unknown,
  sourceText: string,
  fallbackToSourceRate: boolean = false
): number | null | undefined {
  const explicitRates = extractExplicitPercentRates(sourceText);

  let parsed: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    parsed = value;
  } else if (typeof value === 'string' && value.trim()) {
    const cleaned = parseFloat(value.replace(/%/g, '').trim());
    if (Number.isFinite(cleaned)) parsed = cleaned;
  }

  if ((parsed === null || parsed === 0) && fallbackToSourceRate && explicitRates.length > 0) {
    return explicitRates[0];
  }

  if (parsed === null) {
    return value === null ? null : undefined;
  }
  if (parsed < 0) return undefined;
  if (parsed === 0) return 0;

  if (explicitRates.length > 0) {
    // If multiple tax percentages were given (e.g. 10% service charge + 6% SST = 16%), check their sum first
    if (explicitRates.length > 1) {
      const summedExplicit = Number(explicitRates.reduce((s, r) => s + r, 0).toFixed(4));
      if (
        Math.abs(parsed - summedExplicit) < 0.01 ||
        Math.abs(parsed * 100 - summedExplicit) < 0.05
      ) {
        return summedExplicit;
      }
    }
    for (const userPct of explicitRates) {
      if (Math.abs(parsed - userPct) < 0.001) {
        return userPct;
      }
      // Catch Gemini dividing percentage by 10, 100, 1000, 10000, or 12 / 1200 (monthly decimal)
      if (
        Math.abs(parsed * 10 - userPct) < 0.01 ||
        Math.abs(parsed * 100 - userPct) < 0.01 ||
        Math.abs(parsed * 1000 - userPct) < 0.01 ||
        Math.abs(parsed * 10000 - userPct) < 0.01 ||
        Math.abs(parsed * 12 - userPct) < 0.05 ||
        Math.abs(parsed * 1200 - userPct) < 0.05
      ) {
        return userPct;
      }
    }
    if (explicitRates.length === 1 && parsed > 0 && parsed < 1 && explicitRates[0] >= 0.1) {
      return explicitRates[0];
    }
  }

  // Fallback if Gemini returned a raw decimal fraction like 0.0212 or 0.00212 when user didn't type 0.0...
  if (parsed > 0 && parsed < 0.1 && !/\b0\.0+\d+/.test(sourceText)) {
    if (parsed < 0.01) {
      return Number((parsed * 1000).toPrecision(6));
    }
    return Number((parsed * 100).toPrecision(6));
  }

  return Number(parsed.toPrecision(6));
}

function fixMangledPercentText(str: string, sourceText: string): string {
  if (!str) return str;
  const explicitRates = extractExplicitPercentRates(sourceText);
  if (explicitRates.length === 1) {
    const targetPct = explicitRates[0];
    return str.replace(/\b0\.0+\d+\s*%/g, `${targetPct}%`);
  }
  return str;
}

function normalizeCommand(raw: unknown, today: string, sourceText: string = ''): AiCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const intent = textValue(candidate.intent).toLowerCase();
  const data = candidate.data && typeof candidate.data === 'object'
    ? candidate.data as Record<string, unknown>
    : candidate;
  const confidence = typeof candidate.confidence === 'number'
    ? Math.max(0, Math.min(1, candidate.confidence))
    : 0.5;
  const model = textValue(candidate.model) || undefined;

  if (intent === 'transaction' || (!intent && positiveNumber(data.amount))) {
    let normalizedRate = normalizePercentageRate(data.taxRate ?? data.interestRate ?? data.annualInterestRate, sourceText, false);
    const explicitRates = extractExplicitPercentRates(sourceText);
    if (explicitRates.length > 1) {
      const summedExplicit = Number(explicitRates.reduce((s, r) => s + r, 0).toFixed(2));
      if (normalizedRate == null || explicitRates.some((r) => Math.abs((normalizedRate || 0) - r) < 0.01)) {
        normalizedRate = summedExplicit;
      }
    }
    const rawDesc = fixMangledPercentText(textValue(data.description), sourceText);
    const rawNotes = fixMangledPercentText(textValue(data.notes), sourceText);
    const subtotalVal = optionalPositiveNumber(data.subtotal);
    let amountVal = Number(data.amount);
    let taxAmountVal = optionalNonNegativeNumber(data.taxAmount);
    if (subtotalVal && normalizedRate && normalizedRate > 0) {
      const expectedTotal = Number((subtotalVal * (1 + normalizedRate / 100)).toFixed(2));
      if (Math.abs(amountVal - expectedTotal) > 0.2 && data.taxIncluded !== true) {
        taxAmountVal = Number(((subtotalVal * normalizedRate) / 100).toFixed(2));
        amountVal = expectedTotal;
      }
    }
    const transaction: AiTransactionData = {
      amount: amountVal,
      currency: textValue(data.currency).toUpperCase() || 'MYR',
      type: textValue(data.type) as AiTransactionData['type'],
      category: textValue(data.category),
      description: rawDesc,
      date: sanitizeDate(data.date) || today,
      subtotal: subtotalVal,
      taxAmount: taxAmountVal,
      taxRate: normalizedRate,
      taxIncluded: typeof data.taxIncluded === 'boolean' ? data.taxIncluded : undefined,
      taxLabel: textValue(data.taxLabel) || undefined,
      notes: rawNotes || undefined,
    };
    if (
      !VALID_TRANSACTION_TYPES.has(transaction.type) ||
      !validCurrency(transaction.currency) ||
      !isValidDate(transaction.date) ||
      !transaction.category ||
      !transaction.description ||
      (transaction.taxRate !== null && transaction.taxRate !== undefined && transaction.taxRate > 100)
    ) return null;
    return { intent: 'transaction', data: transaction, confidence, model };
  }

  if (intent === 'installment') {
    const hasInterestInSource = /\b(?:interest|rate|p\.?a\.?)\b/i.test(sourceText) || /%/.test(sourceText);
    const normalizedInterest = normalizePercentageRate(
      data.annualInterestRate ?? data.interestRate ?? 0,
      sourceText,
      hasInterestInSource
    ) ?? 0;
    const installment: AiInstallmentData = {
      name: fixMangledPercentText(textValue(data.name || data.description), sourceText),
      totalPrincipal: Number(data.totalPrincipal ?? data.amount),
      currency: textValue(data.currency).toUpperCase() || 'MYR',
      category: textValue(data.category) || 'Shopping',
      tenureMonths: Number(data.tenureMonths ?? data.installmentMonths),
      annualInterestRate: normalizedInterest,
      startDate: sanitizeDate(data.startDate || data.date) || today,
      tripTag: textValue(data.tripTag) || undefined,
      notes: fixMangledPercentText(textValue(data.notes), sourceText) || undefined,
    };
    if (
      !installment.name ||
      !positiveNumber(installment.totalPrincipal) ||
      !validCurrency(installment.currency) ||
      !Number.isInteger(installment.tenureMonths) ||
      installment.tenureMonths < 1 ||
      installment.tenureMonths > 120 ||
      !Number.isFinite(installment.annualInterestRate) ||
      installment.annualInterestRate < 0 ||
      installment.annualInterestRate > 100 ||
      !isValidDate(installment.startDate)
    ) return null;
    return { intent: 'installment', data: installment, confidence, model };
  }

  if (intent === 'trade') {
    const trade: AiTradeData = {
      action: textValue(data.action).toUpperCase() as AiTradeData['action'],
      ticker: textValue(data.ticker).toUpperCase(),
      assetName: textValue(data.assetName || data.name) || undefined,
      assetType: textValue(data.assetType || data.type) || undefined,
      quantity: optionalPositiveNumber(data.quantity),
      price: optionalPositiveNumber(data.price),
      fees: optionalPositiveNumber(data.fees) ?? 0,
      currency: textValue(data.currency).toUpperCase() || 'USD',
      date: sanitizeDate(data.date) || today,
      notes: fixMangledPercentText(textValue(data.notes), sourceText) || undefined,
      isReinvested: Boolean(data.isReinvested || tradeActionIsReinvest(data.action)),
    };
    if (
      !VALID_TRADE_ACTIONS.has(trade.action) ||
      !trade.ticker ||
      !validCurrency(trade.currency) ||
      !isValidDate(trade.date)
    ) return null;
    return { intent: 'trade', data: trade, confidence, model };
  }

  if (intent === 'trip') {
    const trip: AiTripData = {
      name: textValue(data.name || data.tripName),
      destination: textValue(data.destination) || undefined,
      startDate: sanitizeDate(data.startDate || data.date) || today,
      endDate: sanitizeDate(data.endDate) || undefined,
      budget: optionalPositiveNumber(data.budget),
      currency: textValue(data.currency).toUpperCase() || 'MYR',
      rateToMyr: optionalPositiveNumber(data.rateToMyr),
      description: textValue(data.description) || undefined,
    };
    if (
      !trip.name ||
      !validCurrency(trip.currency) ||
      !isValidDate(trip.startDate) ||
      (trip.endDate && !isValidDate(trip.endDate))
    ) return null;
    return { intent: 'trip', data: trip, confidence, model };
  }

  return {
    intent: 'unknown',
    data: null,
    confidence,
    model,
    missingFields: Array.isArray(candidate.missingFields)
      ? candidate.missingFields.filter((field): field is string => typeof field === 'string').slice(0, 5)
      : [],
  };
}

const SYSTEM_PROMPT = `You are a careful financial command parser for a Malaysian personal finance app.
Understand English, Malay, Manglish, Chinese, and mixed language. Return ONLY valid JSON.

Choose exactly one intent:
- transaction: ordinary expense, income, or savings/investment contribution
- installment: a purchase or loan paid over multiple months (e.g. "MacBook RM3600 12 months", "Car loan 50000 60m 2.12% interest")
- trade: stock, ETF, crypto, unit trust, dividend, or reinvestment trade (e.g. "buy 2 AAPL at USD180")
- trip: create a travel plan with dates and budget (e.g. "create Tokyo trip 1 Dec to 5 Dec budget RM3000")
- unknown: insufficient information or unsupported request

Today is {{TODAY}}. Resolve relative dates using today. Default currency is MYR.
Do not invent missing ticker, amount, price, dates, or budget. For trades, quantity and price may be null if the user did not provide them so the existing form can ask the user to complete them.
CRITICAL RULE FOR PERCENTAGES:
- Always output percentage fields (annualInterestRate and taxRate) as human percentage numbers, NEVER as decimal fractions!
- Example: "2.12% interest" -> annualInterestRate MUST be 2.12 (NEVER 0.0212 or 0.00212).
- Example: "6% SST" -> taxRate MUST be 6 (NEVER 0.06).
- In notes or description, keep the exact percentage written by the user (e.g. "2.12%"), never convert it to "0.00212%".

Use these exact shapes:
{
  "intent": "transaction|installment|trade|trip|unknown",
  "confidence": 0.0,
  "data": { ... },
  "missingFields": []
}

Transaction data: amount (final amount paid or received), currency, type (Expense|Income|Investment), category, description, date (YYYY-MM-DD), subtotal, taxAmount, taxRate (percentage number e.g. 6 for 6%), taxIncluded, taxLabel, notes.
For meals and receipts, understand phrases such as "RM10 before 6% SST", "RM10 plus tax", and "RM10 including tax". Calculate the final amount only when the user gives enough information. Never invent a tax rate or tax amount. Put the tax breakdown in the tax fields and a short explanation in notes.
Installment data: name, totalPrincipal, currency, category, tenureMonths (1-120), annualInterestRate (percentage number e.g. 2.12 for 2.12%, NEVER decimal), startDate (YYYY-MM-DD), tripTag, notes.
Trade data: action (BUY|SELL|DIVIDEND|REINVEST), ticker, assetName, assetType, quantity, price, fees, currency, date (YYYY-MM-DD), notes, isReinvested.
Trip data: name, destination, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD), budget, currency, rateToMyr, description.`;

export async function POST(req: NextRequest) {
  try {
    const { session } = await getValidGoogleSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Please sign in with your Google Account to use AI features.' },
        { status: 401 }
      );
    }

    const aiStatus = await recordUserAiCall(session.email);
    if (!aiStatus.allowed) {
      return NextResponse.json(
        { success: false, error: 'Your account access has been restricted by the administrator.' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const today = typeof body?.today === 'string' && isValidDate(body.today)
      ? body.today
      : getLocalDateString();

    if (!text || text.length > 1000) {
      return NextResponse.json({ success: false, error: 'Text is required and must be 1,000 characters or fewer' }, { status: 400 });
    }

    const apiKeys = getLoadBalancedGeminiKeys();
    if (apiKeys.length === 0) {
      return NextResponse.json({ success: false, error: 'GEMINI_API_KEY is not configured in environment' }, { status: 500 });
    }

    const preferredModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const models = [preferredModel, 'gemini-3.5-flash-lite'].filter((v, i, a) => a.indexOf(v) === i);
    let lastError = 'No response from model';

    for (const model of models) {
      let shouldTryNextModel = false;

      for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx += 1) {
        const apiKey = apiKeys[keyIdx];
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{ text: `${SYSTEM_PROMPT.replace('{{TODAY}}', today)}\n\nUser command: ${text}` }],
            }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
              maxOutputTokens: 2048,
              thinkingConfig: {
                thinkingBudget: 0,
              },
            },
          }),
          signal: AbortSignal.timeout(12000),
        });

        if (!res.ok) {
          lastError = `Gemini ${res.status}`;
          if (res.status === 429 || res.status === 401 || res.status === 403) {
            reportGeminiKeyFailure(apiKey, res.status);
            if (keyIdx + 1 < apiKeys.length) {
              continue; // Failover to next configured API key
            }
          }
          if (res.status === 404) {
            shouldTryNextModel = true;
          }
          break;
        }

        const responseData = await res.json();
        const rawJson = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawJson) {
          lastError = 'Empty response from model';
          break;
        }

        try {
          const parsed = JSON.parse(rawJson);
          const command = normalizeCommand(parsed, today, text);
          if (command) return NextResponse.json({ success: true, data: command, model });
          lastError = 'Model returned an invalid command shape';
        } catch {
          lastError = 'Model returned invalid JSON';
        }
        break;
      }

      if (!shouldTryNextModel) break;
    }

    return NextResponse.json({ success: false, error: lastError }, { status: 502 });
  } catch {
    return NextResponse.json({ success: false, error: 'AI command parsing failed' }, { status: 500 });
  }
}
