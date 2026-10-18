/**
 * Intelligent duplicate transaction detection for Kinova Cashflow.
 *
 * Detects whether a pending or newly scanned receipt transaction is likely
 * an accidental duplicate of an existing ledger record.
 */

export interface CandidateTransaction {
  amount: number;
  date: string; // YYYY-MM-DD
  currency?: string;
  description: string;
  category?: string;
  type?: string;
  notes?: string;
  items?: { name: string; amount?: number }[];
  receiptItems?: { name: string; amount?: number }[];
  ignoreId?: string;
}

export interface ExistingTransactionRecord {
  id: string;
  amount: number;
  date: string; // YYYY-MM-DD
  currency?: string;
  description: string;
  notes?: string;
  receiptItems?: { name: string; amount?: number }[];
}

export interface DuplicateMatchResult {
  record: ExistingTransactionRecord;
  reason: 'same_invoice_no' | 'same_day_same_amount' | 'same_items' | 'near_date_same_merchant';
  explanation: string;
}

function parseDaysBetween(dateStrA: string, dateStrB: string): number {
  if (!dateStrA || !dateStrB) return 999;
  const timeA = new Date(dateStrA).getTime();
  const timeB = new Date(dateStrB).getTime();
  if (isNaN(timeA) || isNaN(timeB)) return 999;
  return Math.abs(Math.round((timeA - timeB) / (1000 * 60 * 60 * 24)));
}

function extractInvoiceNumbers(text: string): Set<string> {
  const result = new Set<string>();
  if (!text) return result;
  // Match e.g. "Invoice no: SHL029662", "Inv #12345", "Receipt: ABC-9988", "Tax Invoice: TI-2026-01"
  const regex = /(?:inv(?:oice)?|receipt|rcpt|bill|tax\s*inv|resit|no)[\s.:#№]+([A-Z0-9_-]{4,20})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[1] && !/^\d{1,3}$/.test(match[1])) {
      result.add(match[1].toUpperCase());
    }
  }
  return result;
}

function normalizeDescTokens(text: string): Set<string> {
  const cleaned = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
  const tokens = cleaned.split(/\s+/).filter((t) => t.length >= 2);
  return new Set(tokens);
}

/**
 * Checks a candidate transaction against known ledger transactions
 * and returns all suspected duplicates with clear explanations.
 */
export function findSuspectedDuplicates(
  candidate: CandidateTransaction,
  existingList: ExistingTransactionRecord[]
): DuplicateMatchResult[] {
  if (!candidate || !candidate.amount || candidate.amount <= 0 || !Array.isArray(existingList)) {
    return [];
  }

  const candidateCurrency = (candidate.currency || 'MYR').toUpperCase();
  const candidateAmt = Number(candidate.amount.toFixed(2));
  const candidateDate = candidate.date || '';
  const candidateInvoices = extractInvoiceNumbers(`${candidate.notes || ''} ${candidate.description || ''}`);
  const candidateTokens = normalizeDescTokens(candidate.description);
  const candidateItemNames = (candidate.receiptItems || candidate.items || [])
    .map((it) => it.name.trim().toLowerCase())
    .filter((n) => n.length >= 3);

  const matches: DuplicateMatchResult[] = [];

  for (const existing of existingList) {
    if (!existing) continue;
    if (candidate.ignoreId && (existing.id === candidate.ignoreId || String(existing.id) === String(candidate.ignoreId))) {
      continue;
    }

    const existingCurrency = (existing.currency || 'MYR').toUpperCase();
    if (candidateCurrency !== existingCurrency) continue;

    const existingAmt = Number(Number(existing.amount || 0).toFixed(2));
    if (Math.abs(candidateAmt - existingAmt) >= 0.01) continue;

    const existingDate = existing.date || '';
    const daysDiff = parseDaysBetween(candidateDate, existingDate);

    // Rule 1: Exact matching invoice number in notes or description
    if (candidateInvoices.size > 0) {
      const existingInvoices = extractInvoiceNumbers(`${existing.notes || ''} ${existing.description || ''}`);
      for (const inv of candidateInvoices) {
        if (existingInvoices.has(inv)) {
          matches.push({
            record: existing,
            reason: 'same_invoice_no',
            explanation: `与已记录账单（${existingDate} · ${existing.description}）具有完全相同的发票/收据单号「${inv}」`,
          });
          break;
        }
      }
      if (matches.length > 0 && matches[matches.length - 1].record.id === existing.id) {
        continue;
      }
    }

    // Rule 2: Same Day & Same Amount (Exact match)
    if (candidateDate && existingDate && candidateDate === existingDate) {
      matches.push({
        record: existing,
        reason: 'same_day_same_amount',
        explanation: `当天（${existingDate}）已有金额完全相同（${candidateCurrency} ${candidateAmt.toFixed(2)}）的账目：「${existing.description || '未命名消费'}」`,
      });
      continue;
    }

    // Rule 3: Identical or Overlapping Receipt Line Items (within 14 days)
    if (daysDiff <= 14 && candidateItemNames.length > 0) {
      const existingItemNames = (existing.receiptItems || [])
        .map((it) => it.name.trim().toLowerCase())
        .filter((n) => n.length >= 3);
      
      const overlappingItem = candidateItemNames.find((name) =>
        existingItemNames.some((exName) => exName === name || (name.length >= 5 && exName.includes(name)))
      );

      if (overlappingItem) {
        matches.push({
          record: existing,
          reason: 'same_items',
          explanation: `与 ${existingDate} 的账目「${existing.description}」含有相同的消费细项「${overlappingItem}」，且金额一致`,
        });
        continue;
      }
    }

    // Rule 4: Same Merchant / Description & Same Amount within 3 days
    if (daysDiff <= 3) {
      const existingTokens = normalizeDescTokens(existing.description);
      let sharedCount = 0;
      for (const token of candidateTokens) {
        if (existingTokens.has(token)) sharedCount += 1;
      }

      const isSub = (candidate.description && existing.description) &&
        (candidate.description.toLowerCase().includes(existing.description.toLowerCase()) ||
         existing.description.toLowerCase().includes(candidate.description.toLowerCase()));

      if (isSub || (sharedCount >= 2 && candidateTokens.size <= 4) || (sharedCount >= 1 && candidateTokens.size <= 2)) {
        matches.push({
          record: existing,
          reason: 'near_date_same_merchant',
          explanation: `相隔仅 ${daysDiff} 天（${existingDate}）且商家一致（「${existing.description}」），金额完全相同`,
        });
        continue;
      }
    }
  }

  return matches;
}
