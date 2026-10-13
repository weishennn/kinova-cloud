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
]);

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
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const itemTokens = tokenize(`${item.name} ${item.brand || ''} ${item.productType || ''} ${item.category || ''}`);
  if (itemTokens.length === 0) return 0;

  const matched = queryTokens.filter((queryToken) =>
    itemTokens.some((itemToken) => tokenSimilarity(queryToken, itemToken) >= 0.78),
  ).length;

  return matched === 0 ? 0 : Math.round((matched / queryTokens.length) * 100);
}
