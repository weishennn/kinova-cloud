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
  'where', 'were', 'with', 'you', 'your', 'cheapest', 'cheaper', 'lowest', 'highest',
  '多少', '多少钱', '价格', '价钱', '市价', '请问', '请', '查', '查一下', '查查', '查一查', '查询', '我查', '我想查', '要查',
  '找', '找找', '找一下', '找一找', '我想找', '帮我找', '搜', '搜一下', '搜搜', '搜一搜', '搜索', '我搜',
  '看', '看看', '看一下', '看下', '看一看', '买', '买过', '买的', '买了', '吃', '吃过', '吃了', '吃的',
  '什么', '的', '有', '有没有', '记录', '之前', '上次', '最近', '哪个', '哪', '哪家', '哪间', '哪里', '最便宜', '便宜', '最贵', '贵',
]);

const CHINESE_PREFIX_REGEX = /^(请问|我想要找|我想找|我找|帮我找|请帮我找|找一找|找找|找|我想查|我要查|要查|请帮我查|帮我查查|帮我查|查一查|查一下|查查|查询|我查|查|我想搜|我要搜|我搜|搜一搜|搜一下|搜索|搜|我想看|我想看看|帮我看看|看看|看下|看一下|看一看|问一下|有没有买过|有没有买|有没有|有买过|有买|我买过的|买过的|买过|我买的|买的|买了|我吃过的|吃过的|吃过|吃了|之前买的|之前的|之前|上次买的|上次的|上次|最近买的|最近的|最近|我在|在|我想要|想要|我|这里|这家|这间|这|那里|那家|那间|那)\s*/i;
const CHINESE_SUFFIX_REGEX = /\s*(多少钱|几多钱|多贵|什么价钱|什么价|价钱|价格|是多少|大约多少|多少|市价|售价|记录|呢|呀|啊|啦|吧|么|吗|？|\?|买过|买的|买了|吃过|吃了|吃的|消费多少|消费)+$/i;
const ENGLISH_PREFIX_REGEX = /^(how much (is|was|did i pay for|are)|what (is|was|did i pay for) the (price|cost) of|can you check (the price of)?|check (the price of)?|find (my)?|tell me the price of|show me (the)?|i bought|i paid for|where (is|was|did i buy|were))\s+/i;
const ENGLISH_SUFFIX_REGEX = /\s+(cost|price|how much|i paid|i bought|last time|cheapest|cheaper|\?)$/i;

const COMMON_BILINGUAL_SYNONYMS: Record<string, string[]> = {
  // Food & Dining
  '鸡饭': ['chicken rice', 'nasi ayam', '鸡饭', '海南鸡饭', '烧鸡饭', '白鸡饭'],
  'chicken rice': ['chicken rice', '鸡饭', 'nasi ayam', 'hainanese chicken rice'],
  'nasi ayam': ['nasi ayam', 'chicken rice', '鸡饭'],
  '蛋': ['egg', 'eggs', '鸡蛋', '蛋', 'telur', 'telur ayam'],
  '鸡蛋': ['egg', 'eggs', '鸡蛋', '蛋', 'telur', 'telur ayam'],
  'egg': ['egg', 'eggs', '鸡蛋', '蛋', 'telur', 'telur ayam'],
  'eggs': ['egg', 'eggs', '鸡蛋', '蛋', 'telur', 'telur ayam'],
  'telur': ['telur', 'telur ayam', 'egg', 'eggs', '鸡蛋', '蛋'],
  'telur ayam': ['telur ayam', 'telur', 'egg', 'eggs', '鸡蛋', '蛋'],
  '鸡': ['chicken', 'ayam', '鸡', '鸡肉'],
  '鸡肉': ['chicken', 'ayam', '鸡', '鸡肉'],
  'chicken': ['chicken', '鸡', '鸡肉', 'ayam'],
  'ayam': ['ayam', 'chicken', '鸡', '鸡肉'],
  '猪肉': ['pork', '猪肉'],
  'pork': ['pork', '猪肉'],
  '牛肉': ['beef', 'daging', '牛肉'],
  'beef': ['beef', 'daging', '牛肉'],
  '鱼': ['fish', 'ikan', '鱼'],
  'fish': ['fish', 'ikan', '鱼'],
  '虾': ['prawn', 'shrimp', 'udang', '虾'],
  'prawn': ['prawn', 'shrimp', 'udang', '虾'],
  'shrimp': ['shrimp', 'prawn', 'udang', '虾'],
  '菜': ['vegetable', 'vegetables', 'sayur', '菜', '蔬菜'],
  '蔬菜': ['vegetable', 'vegetables', 'sayur', '菜', '蔬菜'],
  'vegetable': ['vegetable', 'vegetables', 'sayur', '菜', '蔬菜'],
  'vegetables': ['vegetables', 'vegetable', 'sayur', '菜', '蔬菜'],
  '水果': ['fruit', 'fruits', 'buah', '水果'],
  'fruit': ['fruit', 'fruits', 'buah', '水果'],
  'fruits': ['fruits', 'fruit', 'buah', '水果'],
  '苹果': ['apple', '苹果'],
  'apple': ['apple', '苹果'],
  '香蕉': ['banana', 'pisang', '香蕉'],
  'banana': ['banana', 'pisang', '香蕉'],
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
  '炒饭': ['fried rice', 'nasi goreng', '炒饭'],
  'fried rice': ['fried rice', 'nasi goreng', '炒饭'],
  '面': ['noodle', 'noodles', 'mee', '面', '面条', '云吞面', '板面'],
  '面条': ['noodle', 'noodles', 'mee', '面', '面条'],
  'noodle': ['noodle', 'noodles', 'mee', '面', '面条'],
  'noodles': ['noodle', 'noodles', 'mee', '面', '面条'],
  'mee': ['mee', 'noodle', 'noodles', '面'],
  '面包': ['bread', 'roti', '面包', 'toast'],
  'bread': ['bread', 'roti', '面包', 'toast'],
  'roti': ['roti', 'bread', '面包', 'roti canai'],
  '牛奶': ['milk', 'susu', '牛奶', '鲜奶'],
  'milk': ['milk', 'susu', '牛奶', '鲜奶'],

  // Daily Essentials
  '洗发水': ['shampoo', '洗发水', '洗发精', '洗发露'],
  '洗发精': ['shampoo', '洗发水', '洗发精'],
  'shampoo': ['shampoo', '洗发水', '洗发精'],
  '沐浴露': ['body wash', 'shower gel', '沐浴露', '沐浴乳'],
  'body wash': ['body wash', 'shower gel', '沐浴露'],
  '汽油': ['petrol', 'fuel', 'ron95', 'ron97', 'fuelsave', 'fuelsave 95', '汽油', '油钱', 'shell', 'petronas', 'budi madani'],
  '油钱': ['petrol', 'fuel', 'ron95', 'ron97', 'fuelsave', 'fuelsave 95', '汽油', '油钱'],
  'petrol': ['petrol', 'fuel', 'ron95', 'ron97', 'fuelsave', 'fuelsave 95', '汽油', 'shell', 'petronas'],
  'fuelsave': ['fuelsave', 'fuelsave 95', 'ron95', 'petrol', 'fuel', '汽油', 'shell'],
  'fuelsave 95': ['fuelsave 95', 'fuelsave', 'ron95', 'petrol', 'fuel', '汽油', 'shell'],
  'ron95': ['ron95', 'fuelsave', 'fuelsave 95', 'petrol', 'fuel', '汽油', 'shell', 'petronas', 'budi madani'],
  'ron97': ['ron97', 'petrol', 'fuel', '汽油', 'shell', 'petronas'],
  'shell': ['shell', 'shell app', 'fuelsave', 'fuelsave 95', 'petrol', '汽油'],
  'budi madani': ['budi madani', 'subsidy', 'petrol subsidy', 'fuelsave 95', 'ron95', 'petrol'],

  // Local Delights & Desserts
  '豆花': ['豆花', '四夕豆花', 'four beans', 'tau foo fah', 'tofu pudding', '甜品', 'dessert'],
  '四夕豆花': ['四夕豆花', '豆花', 'four beans', 'tau foo fah', 'tofu pudding'],
  'four beans': ['four beans', '四夕豆花', '豆花', 'tau foo fah'],
  'tau foo fah': ['tau foo fah', '豆花', '四夕豆花', 'four beans'],
  '粿条': ['粿条', '炒粿条', 'kuey teow', 'char kuey teow', 'char kway teow'],
  'kuey teow': ['kuey teow', 'char kuey teow', 'char kway teow', '粿条', '炒粿条'],
  'char kuey teow': ['char kuey teow', 'kuey teow', '炒粿条', '粿条'],
  'laksa': ['laksa', 'curry laksa', 'asam laksa', '叻沙'],
  '叻沙': ['叻沙', 'laksa', 'curry laksa', 'asam laksa'],
  'roti canai': ['roti canai', 'roti', 'canai', '印度煎饼'],
  'teh tarik': ['teh tarik', '拉茶', 'teh', '奶茶'],
  'milo': ['milo', 'milo ais', '美禄'],
  'maggi': ['maggi', 'maggi mee', 'maggi goreng', '快熟面', '方便面'],
  '泊车': ['parking', '泊车', '停车', '停车费'],
  '停车': ['parking', '泊车', '停车', '停车费'],
  'parking': ['parking', '泊车', '停车'],
};

export function extractCleanItemKeyword(query: string): string {
  let cleaned = query.trim();

  // Separate Chinese characters from alphanumeric words (e.g. "我查egg" -> "我查 egg")
  cleaned = cleaned
    .replace(/([\u4e00-\u9fa5])([a-zA-Z0-9])/g, '$1 $2')
    .replace(/([a-zA-Z0-9])([\u4e00-\u9fa5])/g, '$1 $2');

  // Strip English and Chinese prefix/suffix iteratively
  for (let i = 0; i < 6; i++) {
    const prev = cleaned;
    cleaned = cleaned.replace(ENGLISH_PREFIX_REGEX, '');
    cleaned = cleaned.replace(ENGLISH_SUFFIX_REGEX, '');
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

  const queryWordCount = lowerKeyword.split(/\s+/).filter(Boolean).length;

  for (const [key, synList] of Object.entries(COMMON_BILINGUAL_SYNONYMS)) {
    const keyLower = key.toLowerCase();
    const isCjk = /[\u4e00-\u9fa5]/.test(keyLower);
    const keyWordCount = keyLower.split(/\s+/).filter(Boolean).length;

    let isMatch = false;
    if (lowerKeyword === keyLower) {
      isMatch = true;
    } else if (keyLower.includes(lowerKeyword)) {
      isMatch = true;
    } else if (lowerKeyword.includes(keyLower)) {
      // In non-CJK (English/Malay), only match if key has the same or greater word count
      // so multi-word queries like "chicken rice" never pick up single-word "chicken" synonyms!
      if (isCjk || keyWordCount >= queryWordCount) {
        isMatch = true;
      }
    }

    if (isMatch) {
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
    .replace(/([\u4e00-\u9fa5])([a-z0-9])/gi, '$1 $2')
    .replace(/([a-z0-9])([\u4e00-\u9fa5])/gi, '$1 $2')
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
    if (!syn) continue;
    const isCjk = /[\u4e00-\u9fa5]/.test(syn);
    if (!isCjk && syn.length < 2) continue;
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
