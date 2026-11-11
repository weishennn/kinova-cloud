import { normalizeToCanonicalCategory } from './canonical-categories.ts';
import {
  cleanPayeeOrMerchantPattern,
  isEligibleHabitMerchant,
  isGenericCommodityTerm,
  isPollutedHabitEntry,
  isRedundantCategoryMapping,
  sanitizeHabitKeywords,
  toCompactHabitToken,
  type HabitCandidateRecord,
  type HabitMemoryItem,
  type MinimalLedgerRecord,
} from './habit-memory-engine.ts';
import {
  ITEMIZED_RULE_TEXT_REGEX,
  SYSTEM_OR_RECEIPT_NOISE_REGEX,
  hasEmbeddedAmountOrPrice,
} from './merchant-rules.ts';

export interface HabitLedgerPatternSummary {
  rawPattern: string;
  sampleDescription: string;
  category: string;
  count: number;
  avgAmount?: number;
}

export interface HabitDropOp {
  id: string;
  rawPattern: string;
  preferredAlias: string;
  learnedSource: HabitMemoryItem['learnedSource'];
  reason: string;
}

export interface HabitMergeOp {
  keepId: string;
  removeIds: string[];
  rawPattern: string;
  preferredAlias: string;
  category: string;
  keywords: string[];
  reason: string;
}

export interface HabitUpdateOp {
  id: string;
  rawPattern: string;
  currentAlias: string;
  preferredAlias: string;
  currentCategory: string;
  category: string;
  currentKeywords: string[];
  keywords: string[];
  reason: string;
}

export interface HabitAddOp {
  rawPattern: string;
  preferredAlias: string;
  category: string;
  keywords: string[];
  timeSlot: 'breakfast' | 'lunch' | 'dinner' | 'any';
  typicalAmount?: number;
  reason: string;
  fromCandidateKey?: string;
}

export interface ValidatedHabitOptimizationPlan {
  summary: string;
  drops: HabitDropOp[];
  merges: HabitMergeOp[];
  updates: HabitUpdateOp[];
  additions: HabitAddOp[];
  clearCandidateKeys: string[];
  hasChanges: boolean;
}

const VALID_TIME_SLOTS = new Set(['breakfast', 'lunch', 'dinner', 'any']);

function sanitizeTimeSlot(value: unknown): 'breakfast' | 'lunch' | 'dinner' | 'any' {
  if (typeof value === 'string' && VALID_TIME_SLOTS.has(value)) {
    return value as 'breakfast' | 'lunch' | 'dinner' | 'any';
  }
  return 'any';
}

function isAllowedAiHabitText(value: string, maxLen: number): boolean {
  const clean = cleanPayeeOrMerchantPattern(value);
  if (!clean || clean.length < 2 || clean.length > maxLen) return false;
  if (SYSTEM_OR_RECEIPT_NOISE_REGEX.test(clean)) return false;
  if (ITEMIZED_RULE_TEXT_REGEX.test(value) || ITEMIZED_RULE_TEXT_REGEX.test(clean)) return false;
  if (isGenericCommodityTerm(clean)) return false;
  if (hasEmbeddedAmountOrPrice(value) || hasEmbeddedAmountOrPrice(clean)) return false;
  return true;
}

function normalizeKeywordSetSignature(keywords: string[]): string {
  return Array.from(new Set(keywords.map((k) => k.toLowerCase().trim()).filter(Boolean)))
    .sort()
    .join('|');
}

/**
 * Aggregates compact recurring merchant/payee patterns from the user's ledger
 * without exposing raw transaction IDs or PII notes to the optimization prompt.
 */
export function summarizeLedgerPatternsForHabitOptimization(
  transactions: MinimalLedgerRecord[],
  currentHabits: HabitMemoryItem[] = [],
  limit: number = 28
): HabitLedgerPatternSummary[] {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  const activeCompacts = new Set(
    currentHabits
      .flatMap((h) => [toCompactHabitToken(h.rawPattern), toCompactHabitToken(h.preferredAlias)])
      .filter(Boolean)
  );

  const buckets = new Map<
    string,
    {
      rawPattern: string;
      descCounts: Map<string, number>;
      catCounts: Map<string, number>;
      amounts: number[];
      count: number;
    }
  >();

  for (const tx of transactions.slice(0, 400)) {
    if (!tx) continue;
    const typeLower = String(tx.type || 'expense').toLowerCase();
    if (typeLower === 'income') continue;

    const desc = cleanPayeeOrMerchantPattern(String(tx.description || ''));
    const merchant = cleanPayeeOrMerchantPattern(String(tx.merchant || ''));
    const notes = String(tx.notes || '');

    let rawPayee = '';
    const noteMatch = notes.match(/(?:\[转账给:\s*|转账给:\s*|DuitNow to:\s*|Payment to:\s*)([^\]\n]+)/i);
    if (noteMatch && noteMatch[1]) {
      rawPayee = cleanPayeeOrMerchantPattern(noteMatch[1]);
    } else if (merchant && isEligibleHabitMerchant(merchant)) {
      rawPayee = merchant;
    } else if (desc && isEligibleHabitMerchant(desc)) {
      rawPayee = desc;
    }

    if (!rawPayee || !isEligibleHabitMerchant(rawPayee)) continue;

    const key = rawPayee.toLowerCase();
    if (!buckets.has(key)) {
      buckets.set(key, {
        rawPattern: rawPayee,
        descCounts: new Map(),
        catCounts: new Map(),
        amounts: [],
        count: 0,
      });
    }

    const bucket = buckets.get(key)!;
    bucket.count += 1;
    const sampleDesc = desc || rawPayee;
    if (sampleDesc && sampleDesc.length <= 48 && !ITEMIZED_RULE_TEXT_REGEX.test(sampleDesc)) {
      bucket.descCounts.set(sampleDesc, (bucket.descCounts.get(sampleDesc) || 0) + 1);
    }
    const cat = normalizeToCanonicalCategory(String(tx.category || 'Other'), 'Expense', sampleDesc);
    if (cat && cat !== 'Other') {
      bucket.catCounts.set(cat, (bucket.catCounts.get(cat) || 0) + 1);
    }
    if (typeof tx.amount === 'number' && Number.isFinite(tx.amount) && tx.amount > 0) {
      bucket.amounts.push(tx.amount);
    }
  }

  const summaries: HabitLedgerPatternSummary[] = [];
  for (const [, bucket] of buckets.entries()) {
    if (bucket.count < 2) continue;

    let topDesc = bucket.rawPattern;
    let topDescCount = 0;
    for (const [d, c] of bucket.descCounts.entries()) {
      if (c > topDescCount) {
        topDescCount = c;
        topDesc = d;
      }
    }

    let topCat = 'Other';
    let topCatCount = 0;
    for (const [cName, c] of bucket.catCounts.entries()) {
      if (c > topCatCount) {
        topCatCount = c;
        topCat = cName;
      }
    }

    const isAlreadyRememberedWithKeywords =
      activeCompacts.has(toCompactHabitToken(bucket.rawPattern)) &&
      currentHabits.some(
        (h) =>
          (toCompactHabitToken(h.rawPattern) === toCompactHabitToken(bucket.rawPattern) ||
            toCompactHabitToken(h.preferredAlias) === toCompactHabitToken(bucket.rawPattern)) &&
          Array.isArray(h.keywords) &&
          h.keywords.length >= 2
      );
    if (isAlreadyRememberedWithKeywords) continue;

    const avgAmount =
      bucket.amounts.length > 0
        ? Number((bucket.amounts.reduce((a, b) => a + b, 0) / bucket.amounts.length).toFixed(2))
        : undefined;

    summaries.push({
      rawPattern: bucket.rawPattern,
      sampleDescription: topDesc,
      category: topCat,
      count: bucket.count,
      avgAmount,
    });
  }

  return summaries
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit));
}

/**
 * Deterministic safety firewall validating Gemini's optimization output against actual habits & candidates.
 * - Never drops non-polluted `manual` rules.
 * - Strictly sanitizes keywords against generic commodity nouns ("sushi", "lunch", "petrol", "汽油").
 * - Rejects additions that merely echo generic single food nouns or redundant 1-to-1 defaults without keywords.
 */
export function validateHabitOptimizationPlan(
  rawPlan: unknown,
  existingHabits: HabitMemoryItem[],
  candidates: HabitCandidateRecord[] = []
): ValidatedHabitOptimizationPlan {
  const habitById = new Map(existingHabits.map((h) => [h.id, h]));
  const rawObj = rawPlan && typeof rawPlan === 'object' ? (rawPlan as Record<string, unknown>) : {};
  const summary =
    typeof rawObj.summary === 'string' && rawObj.summary.trim()
      ? rawObj.summary.trim().slice(0, 260)
      : '已完成习惯记忆智能审查与字眼提炼。';

  const droppedIds = new Set<string>();
  const drops: HabitDropOp[] = [];
  if (Array.isArray(rawObj.drops)) {
    for (const entry of rawObj.drops) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? obj.id.trim() : '';
      const target = habitById.get(id);
      if (!target || droppedIds.has(id)) continue;

      // Protect manually created rules unless they are polluted noise/itemized strings
      if (target.learnedSource === 'manual' && !isPollutedHabitEntry(target)) {
        continue;
      }

      droppedIds.add(id);
      drops.push({
        id,
        rawPattern: target.rawPattern,
        preferredAlias: target.preferredAlias,
        learnedSource: target.learnedSource,
        reason:
          typeof obj.reason === 'string' && obj.reason.trim()
            ? obj.reason.trim().slice(0, 140)
            : '泛指词或冗余规则，无需占用记忆',
      });
    }
  }

  const removedByMergeIds = new Set<string>();
  const keptByMergeIds = new Set<string>();
  const merges: HabitMergeOp[] = [];
  if (Array.isArray(rawObj.merges)) {
    for (const entry of rawObj.merges) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const keepId = typeof obj.keepId === 'string' ? obj.keepId.trim() : '';
      const keepHabit = habitById.get(keepId);
      if (!keepHabit || droppedIds.has(keepId) || removedByMergeIds.has(keepId) || keptByMergeIds.has(keepId)) {
        continue;
      }

      const rawRemoveIds = Array.isArray(obj.removeIds) ? obj.removeIds : [];
      const removeIds: string[] = [];
      for (const rIdRaw of rawRemoveIds) {
        if (typeof rIdRaw !== 'string') continue;
        const rId = rIdRaw.trim();
        const remHabit = habitById.get(rId);
        if (!remHabit || rId === keepId || droppedIds.has(rId) || removedByMergeIds.has(rId) || keptByMergeIds.has(rId)) {
          continue;
        }
        // Only merge non-manual variants into manual rules (or manual into manual only if both are duplicate variants)
        if (remHabit.learnedSource === 'manual' && keepHabit.learnedSource !== 'manual') {
          continue;
        }
        removeIds.push(rId);
      }

      if (removeIds.length === 0) continue;

      const rawPatternCandidate =
        typeof obj.rawPattern === 'string' && isAllowedAiHabitText(obj.rawPattern, 44)
          ? cleanPayeeOrMerchantPattern(obj.rawPattern)
          : keepHabit.rawPattern;
      const preferredAliasCandidate =
        typeof obj.preferredAlias === 'string' &&
        obj.preferredAlias.trim().length >= 2 &&
        obj.preferredAlias.trim().length <= 48 &&
        !ITEMIZED_RULE_TEXT_REGEX.test(obj.preferredAlias)
          ? obj.preferredAlias.trim()
          : keepHabit.preferredAlias;
      const category = normalizeToCanonicalCategory(
        typeof obj.category === 'string' && obj.category.trim() ? obj.category : keepHabit.category,
        'Expense',
        preferredAliasCandidate
      );

      const pooledKeywords = [
        ...(keepHabit.keywords || []),
        ...removeIds.flatMap((rid) => habitById.get(rid)?.keywords || []),
        ...removeIds.map((rid) => habitById.get(rid)?.rawPattern || ''),
        ...(Array.isArray(obj.keywords) ? obj.keywords : []),
      ];
      const keywords = sanitizeHabitKeywords(pooledKeywords, {
        source: 'ai',
        rawPattern: rawPatternCandidate,
        preferredAlias: preferredAliasCandidate,
      });

      keptByMergeIds.add(keepId);
      for (const rId of removeIds) removedByMergeIds.add(rId);

      merges.push({
        keepId,
        removeIds,
        rawPattern: rawPatternCandidate,
        preferredAlias: preferredAliasCandidate,
        category: category === 'Other' && keepHabit.category !== 'Other' ? keepHabit.category : category,
        keywords,
        reason:
          typeof obj.reason === 'string' && obj.reason.trim()
            ? obj.reason.trim().slice(0, 140)
            : '合并同商户不同写法并统一触发字眼',
      });
    }
  }

  const updates: HabitUpdateOp[] = [];
  const updatedIds = new Set<string>();
  if (Array.isArray(rawObj.updates)) {
    for (const entry of rawObj.updates) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? obj.id.trim() : '';
      const target = habitById.get(id);
      if (!target || droppedIds.has(id) || removedByMergeIds.has(id) || keptByMergeIds.has(id) || updatedIds.has(id)) {
        continue;
      }

      const isManual = target.learnedSource === 'manual';
      const nextRaw = target.rawPattern;
      let nextAlias = target.preferredAlias;
      if (
        !isManual &&
        typeof obj.preferredAlias === 'string' &&
        obj.preferredAlias.trim().length >= 2 &&
        obj.preferredAlias.trim().length <= 48 &&
        !ITEMIZED_RULE_TEXT_REGEX.test(obj.preferredAlias) &&
        !SYSTEM_OR_RECEIPT_NOISE_REGEX.test(obj.preferredAlias)
      ) {
        nextAlias = obj.preferredAlias.trim();
      }

      let nextCategory = target.category;
      if (!isManual && typeof obj.category === 'string' && obj.category.trim()) {
        const normalized = normalizeToCanonicalCategory(obj.category, 'Expense', nextAlias);
        if (normalized && (normalized !== 'Other' || target.category === 'Other')) {
          nextCategory = normalized;
        }
      }

      const existingManualKeywords = isManual ? target.keywords || [] : [];
      const incomingAiKeywords = sanitizeHabitKeywords(obj.keywords, {
        source: 'ai',
        rawPattern: nextRaw,
        preferredAlias: nextAlias,
      });
      const existingAutoSafeKeywords = sanitizeHabitKeywords(target.keywords, {
        source: isManual ? 'manual' : 'ai',
        rawPattern: nextRaw,
        preferredAlias: nextAlias,
      });
      const nextKeywords = Array.from(
        new Set([...existingManualKeywords, ...existingAutoSafeKeywords, ...incomingAiKeywords])
      ).slice(0, 10);

      const aliasChanged = nextAlias.trim() !== target.preferredAlias.trim();
      const catChanged = nextCategory !== target.category;
      const kwChanged =
        normalizeKeywordSetSignature(nextKeywords) !==
        normalizeKeywordSetSignature(target.keywords || []);

      if (!aliasChanged && !catChanged && !kwChanged) continue;

      updatedIds.add(id);
      updates.push({
        id,
        rawPattern: nextRaw,
        currentAlias: target.preferredAlias,
        preferredAlias: nextAlias,
        currentCategory: target.category,
        category: nextCategory,
        currentKeywords: target.keywords || [],
        keywords: nextKeywords,
        reason:
          typeof obj.reason === 'string' && obj.reason.trim()
            ? obj.reason.trim().slice(0, 140)
            : '提炼日常字眼与规范分类',
      });
    }
  }

  // Track surviving rawPatterns/compact tokens so AI cannot duplicate an existing habit
  const survivingHabits = existingHabits.filter((h) => !droppedIds.has(h.id) && !removedByMergeIds.has(h.id));
  const seenCompacts = new Set(
    survivingHabits.map((h) => toCompactHabitToken(h.rawPattern)).filter(Boolean)
  );
  const candidateByCompact = new Map(
    candidates.map((c) => [toCompactHabitToken(c.rawPattern), c])
  );

  const additions: HabitAddOp[] = [];
  const clearCandidateKeys = new Set<string>();
  if (Array.isArray(rawObj.additions)) {
    for (const entry of rawObj.additions) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      const rawInput = typeof obj.rawPattern === 'string' ? obj.rawPattern : '';
      const rawPattern = cleanPayeeOrMerchantPattern(rawInput);
      if (!isAllowedAiHabitText(rawPattern, 44)) continue;

      const compact = toCompactHabitToken(rawPattern);
      if (!compact || seenCompacts.has(compact)) continue;

      const preferredAlias =
        typeof obj.preferredAlias === 'string' &&
        obj.preferredAlias.trim().length >= 2 &&
        obj.preferredAlias.trim().length <= 48 &&
        !ITEMIZED_RULE_TEXT_REGEX.test(obj.preferredAlias) &&
        !SYSTEM_OR_RECEIPT_NOISE_REGEX.test(obj.preferredAlias)
          ? obj.preferredAlias.trim()
          : rawPattern;

      const category = normalizeToCanonicalCategory(
        typeof obj.category === 'string' ? obj.category : 'Other',
        'Expense',
        preferredAlias
      );
      if (!category || category === 'Other') continue;

      const keywords = sanitizeHabitKeywords(obj.keywords, {
        source: 'ai',
        rawPattern,
        preferredAlias,
      });

      const isAliasTranslation = rawPattern.toLowerCase() !== preferredAlias.toLowerCase();
      const isRedundantDefault = isRedundantCategoryMapping(rawPattern, preferredAlias, category);
      // Allow curated addition only if it translates an alias, overrides a non-obvious category, OR provides distinctive shorthand keywords
      if (!isAliasTranslation && isRedundantDefault && keywords.length === 0) {
        continue;
      }

      const matchedCand = candidateByCompact.get(compact);
      if (matchedCand) {
        clearCandidateKeys.add(matchedCand.key);
      }

      seenCompacts.add(compact);
      additions.push({
        rawPattern,
        preferredAlias,
        category,
        keywords,
        timeSlot: sanitizeTimeSlot(obj.timeSlot),
        typicalAmount:
          typeof obj.typicalAmount === 'number' && Number.isFinite(obj.typicalAmount) && obj.typicalAmount > 0
            ? Number(obj.typicalAmount.toFixed(2))
            : undefined,
        reason:
          typeof obj.reason === 'string' && obj.reason.trim()
            ? obj.reason.trim().slice(0, 140)
            : '从近期重复记录中提炼高价值习惯',
        ...(matchedCand ? { fromCandidateKey: matchedCand.key } : {}),
      });
    }
  }

  // Drop stale/polluted candidates already handled
  for (const cand of candidates) {
    const compact = toCompactHabitToken(cand.rawPattern);
    if (seenCompacts.has(compact)) {
      clearCandidateKeys.add(cand.key);
    }
  }

  const hasChanges = drops.length > 0 || merges.length > 0 || updates.length > 0 || additions.length > 0;
  return {
    summary,
    drops,
    merges,
    updates,
    additions,
    clearCandidateKeys: Array.from(clearCandidateKeys),
    hasChanges,
  };
}

/**
 * Purely applies a validated (or user-filtered) optimization plan to current habits & candidates.
 */
export function applyHabitOptimizationPlan(
  existingHabits: HabitMemoryItem[],
  candidates: HabitCandidateRecord[],
  plan: ValidatedHabitOptimizationPlan,
  nowIso: string = new Date().toISOString()
): {
  nextHabits: HabitMemoryItem[];
  nextCandidates: HabitCandidateRecord[];
  stats: { dropped: number; merged: number; updated: number; added: number };
} {
  const safeDrops = Array.isArray(plan.drops) ? plan.drops : [];
  const safeMerges = Array.isArray(plan.merges) ? plan.merges : [];
  const safeUpdates = Array.isArray(plan.updates) ? plan.updates : [];
  const safeAdditions = Array.isArray(plan.additions) ? plan.additions : [];
  const safeClearKeys = Array.isArray(plan.clearCandidateKeys) ? plan.clearCandidateKeys : [];

  const dropIds = new Set(safeDrops.map((d) => d.id));
  const mergeMap = new Map(safeMerges.map((m) => [m.keepId, m]));
  const removedByMerge = new Set(safeMerges.flatMap((m) => m.removeIds || []));
  const updateMap = new Map(safeUpdates.map((u) => [u.id, u]));

  const nextHabits: HabitMemoryItem[] = [];
  let dropped = 0;
  let merged = 0;
  let updated = 0;

  for (const habit of existingHabits) {
    if (dropIds.has(habit.id)) {
      dropped += 1;
      continue;
    }
    if (removedByMerge.has(habit.id)) {
      continue;
    }

    const mergeOp = mergeMap.get(habit.id);
    if (mergeOp) {
      merged += 1;
      const removedFreqSum = mergeOp.removeIds.reduce((sum, rid) => {
        const match = existingHabits.find((h) => h.id === rid);
        return sum + (match?.frequency || 1);
      }, 0);
      nextHabits.push({
        ...habit,
        rawPattern: mergeOp.rawPattern,
        preferredAlias: mergeOp.preferredAlias,
        category: mergeOp.category,
        keywords: mergeOp.keywords.length > 0 ? mergeOp.keywords : undefined,
        aiNote: mergeOp.reason,
        frequency: (habit.frequency || 1) + removedFreqSum,
        confidence: Math.min(1.0, Math.max(habit.confidence || 0.8, 0.88)),
        updatedAt: nowIso,
      });
      continue;
    }

    const updateOp = updateMap.get(habit.id);
    if (updateOp) {
      updated += 1;
      nextHabits.push({
        ...habit,
        preferredAlias: updateOp.preferredAlias,
        category: updateOp.category,
        keywords: updateOp.keywords.length > 0 ? updateOp.keywords : undefined,
        aiNote: updateOp.reason,
        updatedAt: nowIso,
      });
      continue;
    }

    nextHabits.push(habit);
  }

  let added = 0;
  for (const addOp of safeAdditions) {
    const exists = nextHabits.some(
      (h) => toCompactHabitToken(h.rawPattern) === toCompactHabitToken(addOp.rawPattern)
    );
    if (exists) continue;
    added += 1;
    nextHabits.unshift({
      id: `habit_ai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      rawPattern: addOp.rawPattern,
      preferredAlias: addOp.preferredAlias,
      category: addOp.category,
      keywords: Array.isArray(addOp.keywords) && addOp.keywords.length > 0 ? addOp.keywords : undefined,
      aiNote: addOp.reason,
      typicalAmount: addOp.typicalAmount,
      timeSlot: addOp.timeSlot || 'any',
      frequency: 2,
      confidence: 0.9,
      learnedSource: addOp.rawPattern.toLowerCase() !== addOp.preferredAlias.toLowerCase() ? 'auto_learned' : 'user_confirmed',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  const clearCandSet = new Set([
    ...safeClearKeys,
    ...safeAdditions.map((a) => a.fromCandidateKey).filter((k): k is string => Boolean(k)),
  ]);
  const nextCandidates = candidates.filter((c) => !clearCandSet.has(c.key));

  return {
    nextHabits,
    nextCandidates,
    stats: { dropped, merged, updated, added },
  };
}
