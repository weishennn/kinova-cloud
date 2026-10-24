export interface EvaluatedMoneyResult {
  value: number | null;
  isExpression: boolean;
  isComplete: boolean;
  formatted: string;
}

/**
 * Safely evaluates a money math expression without eval().
 * Supports +, -, *, ×, /, ÷, parentheses (), and percentage terms (e.g. 50 + 6%, 100 - 15%).
 */
export function evaluateMoneyExpression(rawInput: string): EvaluatedMoneyResult {
  const cleaned = rawInput
    .replace(/,/g, '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .trim();

  if (!cleaned) {
    return { value: null, isExpression: false, isComplete: false, formatted: '' };
  }

  // Check if plain number
  if (/^[+-]?\d+(\.\d+)?$/.test(cleaned)) {
    const num = parseFloat(cleaned);
    if (!Number.isFinite(num)) {
      return { value: null, isExpression: false, isComplete: false, formatted: '' };
    }
    return {
      value: Number(num.toFixed(2)),
      isExpression: false,
      isComplete: true,
      formatted: num.toFixed(2),
    };
  }

  const isExpression = /[+\-*/%()]/.test(cleaned);

  // Validate allowed characters only
  if (!/^[0-9.+\-*/%()\s]+$/.test(cleaned)) {
    return { value: null, isExpression, isComplete: false, formatted: '' };
  }

  const isComplete = !/[+\-*/(]$/.test(cleaned.replace(/\s+/g, ''));

  // Trim trailing incomplete operators so live preview still works mid-typing
  let exprToParse = cleaned.replace(/\s+/g, '');
  exprToParse = exprToParse.replace(/[+\-*/.(]+$/, '');
  if (!exprToParse) {
    return { value: null, isExpression, isComplete: false, formatted: '' };
  }

  // Balance any unclosed parentheses for live preview
  const openCount = (exprToParse.match(/\(/g) || []).length;
  const closeCount = (exprToParse.match(/\)/g) || []).length;
  if (openCount > closeCount) {
    exprToParse += ')'.repeat(openCount - closeCount);
  }

  try {
    const result = parseExpression(exprToParse);
    if (result === null || !Number.isFinite(result)) {
      return { value: null, isExpression, isComplete: false, formatted: '' };
    }
    const rounded = Number(result.toFixed(2));
    return {
      value: rounded,
      isExpression,
      isComplete,
      formatted: rounded.toFixed(2),
    };
  } catch {
    return { value: null, isExpression, isComplete: false, formatted: '' };
  }
}

function parseExpression(expr: string): number | null {
  let pos = 0;

  function peek(): string {
    return expr[pos] || '';
  }

  function consume(): string {
    return expr[pos++] || '';
  }

  // Grammar:
  // Expr -> Term (( '+' | '-' ) Term ('%')?)*
  // Term -> Factor (( '*' | '/' ) Factor)*
  // Factor -> ('+' | '-') Factor | '(' Expr ')' | Number ('%')?
  function parseAddSub(): number {
    let left = parseMulDiv();
    let percentBase = left;
    while (pos < expr.length && (peek() === '+' || peek() === '-')) {
      const op = consume();
      // Check if the right operand is a simple number/factor followed by '%'
      const savedPos = pos;
      let right = parseMulDiv();
      // If right was a percentage literal in an additive context (e.g. 100 + 10% + 6%),
      // treat each additive percentage as a percentage of the pre-tax base (100 * 0.10 + 100 * 0.06 = 116)
      const sliceAfterOp = expr.slice(savedPos, pos);
      const isDirectPercent = /^\d+(\.\d+)?%$/.test(sliceAfterOp);
      if (isDirectPercent) {
        const pctRaw = parseFloat(sliceAfterOp.slice(0, -1));
        right = (op === '+' ? percentBase : left) * (pctRaw / 100);
        if (op === '+') {
          left += right;
        } else {
          left -= right;
          percentBase = left;
        }
      } else {
        if (op === '+') left += right;
        else left -= right;
        percentBase = left;
      }
    }
    return left;
  }

  function parseMulDiv(): number {
    let left = parseFactor();
    while (pos < expr.length && (peek() === '*' || peek() === '/')) {
      const op = consume();
      const right = parseFactor();
      if (op === '*') left *= right;
      else {
        if (right === 0) return NaN;
        left /= right;
      }
    }
    return left;
  }

  function parseFactor(): number {
    if (peek() === '+') {
      consume();
      return parseFactor();
    }
    if (peek() === '-') {
      consume();
      return -parseFactor();
    }
    if (peek() === '(') {
      consume(); // '('
      const val = parseAddSub();
      if (peek() === ')') consume();
      if (peek() === '%') {
        consume();
        return val / 100;
      }
      return val;
    }

    // Parse number
    const start = pos;
    while (pos < expr.length && /[0-9.]/.test(peek())) {
      pos++;
    }
    if (start === pos) return NaN;
    const num = parseFloat(expr.slice(start, pos));
    if (peek() === '%') {
      consume();
      return num / 100;
    }
    return num;
  }

  const output = parseAddSub();
  if (pos < expr.length) return null;
  return output;
}
