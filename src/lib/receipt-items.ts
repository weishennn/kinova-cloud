export interface StoredReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  brand?: string;
  productType?: string;
  category?: string;
  includedInExpense?: boolean;
}

const RECEIPT_ITEMS_MARKER = '[KINOVA_RECEIPT_ITEMS_V1:';
const MAX_STORED_ITEMS = 40;

function normalizeReceiptItems(value: unknown): StoredReceiptItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : '';
      const quantity = typeof item.quantity === 'number' && Number.isFinite(item.quantity)
        ? Math.max(1, Math.round(item.quantity))
        : 1;
      const amount = typeof item.amount === 'number' && Number.isFinite(item.amount) && item.amount > 0
        ? Number(item.amount.toFixed(2))
        : 0;
      const unitPrice = typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice) && item.unitPrice > 0
        ? Number(item.unitPrice.toFixed(2))
        : amount > 0 ? Number((amount / quantity).toFixed(2)) : 0;

      return {
        name,
        quantity,
        unitPrice,
        amount,
        brand: typeof item.brand === 'string' ? item.brand.trim().slice(0, 80) : undefined,
        productType: typeof item.productType === 'string' ? item.productType.trim().slice(0, 80) : undefined,
        category: typeof item.category === 'string' ? item.category.trim().slice(0, 80) : undefined,
        includedInExpense: typeof item.includedInExpense === 'boolean' ? item.includedInExpense : undefined,
      };
    })
    .filter((item) => item.name && item.amount > 0 && item.unitPrice > 0)
    .slice(0, MAX_STORED_ITEMS);
}

export function stripReceiptItemsFromNotes(notes: string): string {
  const markerIndex = notes.lastIndexOf(RECEIPT_ITEMS_MARKER);
  if (markerIndex < 0) return notes.trim();
  const markerIsStandalone = markerIndex === 0 || notes[markerIndex - 1] === '\n';
  if (!markerIsStandalone || !notes.slice(markerIndex).endsWith(']')) return notes.trim();
  return notes.slice(0, markerIndex).trim();
}

export function parseReceiptItemsFromNotes(notes: string): StoredReceiptItem[] {
  const markerIndex = notes.lastIndexOf(RECEIPT_ITEMS_MARKER);
  if (markerIndex < 0 || (markerIndex > 0 && notes[markerIndex - 1] !== '\n')) return [];

  const markerValue = notes.slice(markerIndex + RECEIPT_ITEMS_MARKER.length);
  if (!markerValue.endsWith(']')) return [];

  try {
    const decoded = decodeURIComponent(markerValue.slice(0, -1));
    return normalizeReceiptItems(JSON.parse(decoded));
  } catch {
    return [];
  }
}

export function parseLegacyPaidItemsFromNotes(notes: string): StoredReceiptItem[] {
  const block = notes.match(/\[Paid items:\s*([\s\S]*?)\]/i)?.[1];
  if (!block) return [];

  const items: StoredReceiptItem[] = [];
  const pattern = /([^,]+?)\s*\(([A-Z]{3})\s+([0-9]+(?:\.[0-9]{1,2})?)\)/g;
  for (const match of block.matchAll(pattern)) {
    const name = match[1].trim();
    const amount = Number(match[3]);
    if (!name || !Number.isFinite(amount) || amount <= 0) continue;
    items.push({ name, quantity: 1, unitPrice: amount, amount, includedInExpense: true });
  }
  return normalizeReceiptItems(items);
}

export function withReceiptItemsInNotes(notes: string, items: unknown): string {
  const cleanNotes = stripReceiptItemsFromNotes(notes);
  const safeItems = normalizeReceiptItems(items);
  if (safeItems.length === 0) return cleanNotes;

  const encodedItems = encodeURIComponent(JSON.stringify(safeItems));
  return `${cleanNotes}${cleanNotes ? '\n' : ''}${RECEIPT_ITEMS_MARKER}${encodedItems}]`;
}

const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'ago', 'bought', 'buy', 'can', 'cost', 'could', 'did', 'do', 'does', 'find',
  'for', 'have', 'how', 'i', 'is', 'item', 'items', 'last', 'like', 'me', 'much', 'my', 'of', 'on', 'paid',
  'pay', 'please', 'price', 'product', 'products', 'previously', 'recent', 'remember', 'search', 'show', 'some',
  'something', 'tell', 'the', 'that', 'these', 'thing', 'things', 'this', 'those', 'time', 'was', 'what', 'when',
  'where', 'were', 'with', 'you', 'your',
  '多少', '多少钱', '价格', '请问', '查', '查一下', '买', '过', '什么', '的', '有', '记录', '之前', '最近', '哪个', '哪',
]);

const CHINESE_PREFIX_REGEX = /^(我找|我想找|帮我找|请帮我找|请问|请帮我查|帮我查|查一下|查查|查|问一下|有没有|看看|我买过的|买过的|买过|我买的|买的|吃过的|吃过|之前买的|之前的|上次买的|上次的)\s*/i;
const CHINESE_SUFFIX_REGEX = /\s*(多少钱|几多钱|多贵|什么价钱|什么价|价钱|价格|是多少|大约多少|多少|记录|呢|呀|啊|？|\?)+$/i;
const ENGLISH_PREFIX_REGEX = /^(how much (is|was|did i pay for|are)|what (is|was|did i pay for) the (price|cost) of|can you check (the price of)?|check (the price of)?|find (my)?|tell me the price of|show me (the)?|i bought|i paid for)\s+/i;
const ENGLISH_SUFFIX_REGEX = /\s+(cost|price|how much|i paid|i bought|last time|\?)$/i;

const COMMON_BILINGUAL_SYNONYMS: Record<string, string[]> = {
  // Food & Dining
  '鸡饭': ['chicken rice', 'nasi ayam', '鸡饭', '海南鸡饭', '烧鸡饭', '白鸡饭'],
  'chicken rice': ['chicken rice', '鸡饭', 'nasi ayam', 'hainanese chicken rice'],
  'nasi ayam': ['nasi ayam', 'chicken rice', '鸡饭'],
  '蛋': ['egg', 'eggs', '鸡蛋', 'telur'],
  '鸡蛋': ['egg', 'eggs', '鸡蛋', 'telur'],
  'egg': ['egg', 'eggs', '鸡蛋', '蛋'],
  'eggs': ['egg', 'eggs', '鸡蛋', '蛋'],
  '咖啡': ['coffee', 'kopi', '咖啡', 'cafe', 'latte', 'cappuccino'],
  'coffee': ['coffee', '咖啡', 'kopi', 'cafe'],
  'kopi': ['kopi', 'coffee', '咖啡'],
  '奶茶': ['milk tea', 'teh', '奶茶', 'boba'],
  'teh': ['teh', 'tea', 'milk tea', '奶茶', '茶'],
  '茶': ['tea', 'teh', '绿茶', '奶茶'],
  'tea': ['tea', 'teh', '茶', 'green tea'],
  '椰浆饭': ['nasi lemak', '椰浆饭'],
  'nasi lemak': ['nasi lemak', '椰浆饭'],
  '杂饭': ['mixed rice', 'economy rice', '杂饭', '杂菜饭', '经济饭'],
  '经济饭': ['mixed rice', 'economy rice', '杂饭', '杂菜饭', '经济饭'],
  '杂菜饭': ['mixed rice', 'economy rice', '杂饭', '杂菜饭', '经济饭'],
  'mixed rice': ['mixed rice', 'economy rice', '杂饭', '经济饭'],
  'economy rice': ['economy rice', 'mixed rice', '经济饭', '杂饭'],
  '炒饭': ['fried rice', '炒饭'],
  'fried rice': ['fried rice', '炒饭'],
  '面': ['noodle', 'noodles', 'mee', '面', '面条', '云吞面', '板面'],
  '面条': ['noodle', 'noodles', 'mee', '面', '面条'],
  'noodle': ['noodle', 'noodles', 'mee', '面', '面条'],
  'noodles': ['noodle', 'noodles', 'mee', '面', '面条'],
  'mee': ['mee', 'noodle', 'noodles', '面'],
  '面包': ['bread', 'roti', '面包', 'toast'],
  'bread': ['bread', 'roti', '面包'],
  'roti': ['roti', 'bread', '面包', 'roti canai'],
  '牛奶': ['milk', '牛奶', '鲜奶'],
  'milk': ['milk', '牛奶'],

  // Daily Essentials
  '洗发水': ['shampoo', '洗发水', '洗发精', '洗发露'],
  '洗发精': ['shampoo', '洗发水', '洗发精'],
  'shampoo': ['shampoo', '洗发水', '洗发精'],
  '沐浴露': ['body wash', 'shower gel', '沐浴露', '沐浴乳'],
  'body wash': ['body wash', 'shower gel', '沐浴露'],
  '汽油': ['petrol', 'fuel', 'ron95', 'ron97', '汽油', '油钱', 'shell', 'petronas'],
  '油钱': ['petrol', 'fuel', 'ron95', 'ron97', '汽油', '油钱'],
  'petrol': ['petrol', 'fuel', 'ron95', 'ron97', '汽油'],
  '泊车': ['parking', '泊车', '停车', '停车费'],
  '停车': ['parking', '泊车', '停车', '停车费'],
  'parking': ['parking', '泊车', '停车'],
};

export function extractCleanItemKeyword(query: string): string {
  let cleaned = query.trim();

  // Strip English prefix/suffix
  cleaned = cleaned.replace(ENGLISH_PREFIX_REGEX, '');
  cleaned = cleaned.replace(ENGLISH_SUFFIX_REGEX, '');

  // Strip Chinese prefix/suffix
  for (let i = 0; i < 3; i++) {
    const prev = cleaned;
    cleaned = cleaned.replace(CHINESE_PREFIX_REGEX, '');
    cleaned = cleaned.replace(CHINESE_SUFFIX_REGEX, '');
    cleaned = cleaned.replace(/^[？?！!，,。.\s]+|[？?！!，,。.\s]+$/g, '');
    if (cleaned === prev) break;
  }

  cleaned = cleaned.trim();
  return cleaned || query.trim();
}

export function getItemSearchTarget(rawQuery: string): { coreKeyword: string; synonyms: string[] } {
  const cleanKeyword = extractCleanItemKeyword(rawQuery);
  const lowerKeyword = cleanKeyword.toLowerCase();

  const synonymsSet = new Set<string>();
  synonymsSet.add(cleanKeyword);
  synonymsSet.add(lowerKeyword);

  for (const [key, synList] of Object.entries(COMMON_BILINGUAL_SYNONYMS)) {
    const keyLower = key.toLowerCase();
    if (lowerKeyword === keyLower || lowerKeyword.includes(keyLower) || keyLower.includes(lowerKeyword)) {
      for (const syn of synList) {
        synonymsSet.add(syn.toLowerCase());
      }
    }
  }

  return {
    coreKeyword: cleanKeyword,
    synonyms: Array.from(synonymsSet).filter(Boolean),
  };
}

function tokenize(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !QUERY_STOP_WORDS.has(token));
}

function tokenSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.startsWith(right) || right.startsWith(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  if (Math.min(left.length, right.length) < 4) return 0;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

export function scoreReceiptItemQuery(item: StoredReceiptItem, query: string): number {
  const cleanQuery = query.toLowerCase().trim();
  if (!cleanQuery) return 0;

  const itemFullText = `${item.name} ${item.brand || ''} ${item.productType || ''} ${item.category || ''}`.toLowerCase().trim();
  if (!itemFullText) return 0;

  // 1. Direct match on clean query
  if (itemFullText.includes(cleanQuery)) {
    return 100;
  }
  if (item.name.toLowerCase().trim() && cleanQuery.includes(item.name.toLowerCase().trim())) {
    return 95;
  }

  // 2. Extract core keyword & bilingual synonyms (e.g. "我找我买过的鸡饭多少钱" -> "鸡饭" -> ["鸡饭", "chicken rice", "nasi ayam"])
  const { coreKeyword, synonyms } = getItemSearchTarget(cleanQuery);
  const coreLower = coreKeyword.toLowerCase().trim();

  for (const syn of [coreLower, ...synonyms]) {
    if (!syn || syn.length < 2) continue;
    if (itemFullText.includes(syn)) return 100;
    if (item.name.toLowerCase().trim() && syn.includes(item.name.toLowerCase().trim())) return 95;
  }

  // 3. Multi-token strict match using core keyword
  const effectiveQuery = (coreLower && coreLower.length >= 2) ? coreLower : cleanQuery;
  const queryTokens = tokenize(effectiveQuery);
  if (queryTokens.length === 0) return 0;

  const itemTokens = tokenize(itemFullText);
  if (itemTokens.length === 0) return 0;

  // Count which query tokens are matched in item
  const matchedTokens = queryTokens.filter((queryToken) => {
    if (itemFullText.includes(queryToken)) return true;
    return itemTokens.some((itemToken) => tokenSimilarity(queryToken, itemToken) >= 0.8);
  });

  const matchCount = matchedTokens.length;

  // Strict multi-token requirement:
  // - 1 token: requires 1 match
  // - 2 tokens (e.g. "chicken rice"): MUST match both tokens! Never let "omu rice" match "chicken rice"!
  // - 3+ tokens: requires at least 75% coverage
  if (queryTokens.length === 1) {
    return matchCount === 1 ? 88 : 0;
  }

  if (queryTokens.length === 2) {
    return matchCount === 2 ? 92 : 0;
  }

  const ratio = matchCount / queryTokens.length;
  if (ratio < 0.75) return 0;
  return Math.round(ratio * 100);
}
