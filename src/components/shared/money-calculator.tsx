'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calculator, Delete, Check, RotateCcw } from 'lucide-react';

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

interface MoneyCalculatorProps {
  value: string;
  onChange: (newValue: string) => void;
  currency?: string;
  compact?: boolean;
  defaultOpen?: boolean;
  showQuickBarWhenClosed?: boolean;
}

/**
 * Reusable inline Money Calculator.
 * Can be attached right below any money input field across the app so the user can
 * calculate amounts without leaving the form.
 */
export function MoneyCalculator({
  value,
  onChange,
  currency = 'MYR',
  defaultOpen = false,
}: MoneyCalculatorProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [expression, setExpression] = useState<string>(value || '');
  const [lastHistory, setLastHistory] = useState<string>('');

  // Keep expression synced when external value changes (e.g. user types in the main input or resets form)
  useEffect(() => {
    const evaluatedCurrent = evaluateMoneyExpression(expression);
    const externalNum = parseFloat(value);
    if (!value) {
      if (!/[+\-*/×÷%()]/.test(expression)) {
        setExpression('');
        setLastHistory('');
      }
      return;
    }
    if (
      Number.isFinite(externalNum) &&
      evaluatedCurrent.value !== null &&
      Math.abs(evaluatedCurrent.value - externalNum) < 0.005
    ) {
      // External value already matches our current expression's evaluated result
      return;
    }
    setExpression(value);
  }, [value]);

  const evaluated = evaluateMoneyExpression(expression);

  const handleExpressionChange = (nextExpr: string) => {
    setExpression(nextExpr);
    const res = evaluateMoneyExpression(nextExpr);
    if (res.value !== null && res.value >= 0) {
      // Format cleanly: avoid forcing .00 if user is still typing simple integer, unless it's an expression result
      const strVal = res.isExpression
        ? String(Number(res.value.toFixed(2)))
        : nextExpr.trim();
      onChange(strVal);
    } else if (!nextExpr.trim()) {
      onChange('');
    }
  };

  const appendToken = (token: string) => {
    const trimmed = expression.trim();
    const isOperator = ['+', '-', '×', '÷'].includes(token);

    if (!trimmed && isOperator) {
      const currentVal = parseFloat(value) || 0;
      if (currentVal > 0) {
        handleExpressionChange(`${currentVal} ${token} `);
      }
      return;
    }

    // Replace trailing operator if tapping another operator
    if (isOperator && /[+\-×÷*/]\s*$/.test(expression)) {
      const replaced = expression.replace(/[+\-×÷*/]\s*$/, `${token} `);
      handleExpressionChange(replaced);
      return;
    }

    const next = isOperator ? `${expression.trimEnd()} ${token} ` : `${expression}${token}`;
    handleExpressionChange(next);
  };

  const handleBackspace = () => {
    const trimmedEnd = expression.replace(/\s+$/, '');
    if (!trimmedEnd) {
      handleExpressionChange('');
      return;
    }
    const next = trimmedEnd.slice(0, -1).replace(/\s+$/, '');
    handleExpressionChange(next);
  };

  const handleClear = () => {
    setExpression('');
    setLastHistory('');
    onChange('');
  };

  const handleApplyEquals = () => {
    if (evaluated.value !== null && evaluated.value >= 0) {
      if (evaluated.isExpression) {
        setLastHistory(`${expression.trim()} = ${currency} ${evaluated.value.toFixed(2)}`);
      }
      const clean = Number(evaluated.value.toFixed(2)).toString();
      setExpression(clean);
      onChange(clean);
    }
  };

  return (
    <div className="space-y-1.5">
      {/* Compact Calculator Toggle Row */}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-expanded={isOpen}
          className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[11px] font-bold border transition-all cursor-pointer touch-manipulation active:scale-95 ${
            isOpen
              ? 'border-indigo-500 bg-indigo-500/20 text-indigo-800 dark:text-indigo-200 shadow-sm'
              : 'border-slate-200 dark:border-zinc-800 bg-slate-100/90 dark:bg-zinc-900/70 text-slate-700 dark:text-zinc-300 hover:border-indigo-500/40 hover:text-slate-950 dark:hover:text-white'
          }`}
        >
          <Calculator className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          <span>{isOpen ? 'Hide Calculator' : 'Calculator'}</span>
        </button>

        {/* Live Calculation Badge if user has an active expression or recent calculation */}
        {(evaluated.isExpression && evaluated.value !== null) ? (
          <button
            type="button"
            onClick={handleApplyEquals}
            className="inline-flex items-center gap-1 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-mono font-bold text-emerald-800 dark:text-emerald-300 cursor-pointer hover:bg-emerald-500/25 transition-colors"
            title="Tap to lock in calculated total"
          >
            <span>= {currency} {evaluated.value.toFixed(2)}</span>
            <Check className="h-3 w-3" />
          </button>
        ) : lastHistory ? (
          <span className="text-[10px] font-mono text-indigo-700 dark:text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 rounded-lg truncate max-w-[220px]">
            🧾 {lastHistory}
          </span>
        ) : null}
      </div>

      {/* Expandable Calculator Pad */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="rounded-2xl border border-indigo-500/30 bg-slate-50/95 dark:bg-zinc-900/90 p-3 shadow-inner space-y-2.5">
              {/* Expression Input / Tape Display */}
              <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-zinc-400 font-medium mb-0.5">
                    <span>Formula (e.g. 25 + 12 - 3 + 6%)</span>
                    {lastHistory && (
                      <span className="font-mono text-indigo-700 dark:text-indigo-400 truncate ml-2">{lastHistory}</span>
                    )}
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={expression}
                    onChange={(e) => handleExpressionChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleApplyEquals();
                      }
                    }}
                    placeholder="0.00 (e.g. 45 + 12.50 - 5)"
                    aria-label="Calculator formula input"
                    className="w-full bg-transparent text-sm sm:text-base font-mono font-bold text-slate-950 dark:text-white outline-none placeholder:text-slate-400 dark:placeholder:text-zinc-600"
                  />
                </div>
                <div className="text-right shrink-0 pl-2 border-l border-slate-200 dark:border-zinc-800">
                  <span className="block text-[9px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                    Result ({currency})
                  </span>
                  <span className="font-mono text-sm sm:text-base font-extrabold text-emerald-700 dark:text-emerald-400 tabular-nums">
                    {evaluated.value !== null ? evaluated.value.toFixed(2) : '0.00'}
                  </span>
                </div>
              </div>

              {/* Keypad Grid */}
              <div className="grid grid-cols-4 gap-1.5">
                {/* Row 1 */}
                <button
                  type="button"
                  onClick={handleClear}
                  className="min-h-[38px] rounded-xl border border-rose-500/25 bg-rose-500/10 text-xs font-bold text-rose-800 dark:text-rose-300 hover:bg-rose-500/20 transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-1"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>C</span>
                </button>
                <button
                  type="button"
                  onClick={handleBackspace}
                  aria-label="Backspace"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-bold text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all cursor-pointer active:scale-95 flex items-center justify-center"
                >
                  <Delete className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => appendToken('%')}
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-mono font-bold text-indigo-700 dark:text-indigo-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all cursor-pointer active:scale-95 flex items-center justify-center"
                >
                  %
                </button>
                <button
                  type="button"
                  onClick={() => appendToken('÷')}
                  className="min-h-[38px] rounded-xl border border-indigo-500/30 bg-indigo-500/15 text-sm font-mono font-bold text-indigo-800 dark:text-indigo-300 hover:bg-indigo-500/25 transition-all cursor-pointer active:scale-95"
                >
                  ÷
                </button>

                {/* Row 2 */}
                {['7', '8', '9'].map((digit) => (
                  <button
                    key={digit}
                    type="button"
                    onClick={() => appendToken(digit)}
                    className="min-h-[38px] rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-sm font-mono font-bold text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all cursor-pointer active:scale-95"
                  >
                    {digit}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => appendToken('×')}
                  className="min-h-[38px] rounded-xl border border-indigo-500/30 bg-indigo-500/15 text-sm font-mono font-bold text-indigo-800 dark:text-indigo-300 hover:bg-indigo-500/25 transition-all cursor-pointer active:scale-95"
                >
                  ×
                </button>

                {/* Row 3 */}
                {['4', '5', '6'].map((digit) => (
                  <button
                    key={digit}
                    type="button"
                    onClick={() => appendToken(digit)}
                    className="min-h-[38px] rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-sm font-mono font-bold text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all cursor-pointer active:scale-95"
                  >
                    {digit}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => appendToken('-')}
                  className="min-h-[38px] rounded-xl border border-rose-500/30 bg-rose-500/15 text-base font-mono font-bold text-rose-800 dark:text-rose-300 hover:bg-rose-500/25 transition-all cursor-pointer active:scale-95"
                  title="Deduct (-)"
                >
                  −
                </button>

                {/* Row 4 */}
                {['1', '2', '3'].map((digit) => (
                  <button
                    key={digit}
                    type="button"
                    onClick={() => appendToken(digit)}
                    className="min-h-[38px] rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-sm font-mono font-bold text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all cursor-pointer active:scale-95"
                  >
                    {digit}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => appendToken('+')}
                  className="min-h-[38px] rounded-xl border border-emerald-500/30 bg-emerald-500/15 text-base font-mono font-bold text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/25 transition-all cursor-pointer active:scale-95"
                  title="Add (+)"
                >
                  +
                </button>

                {/* Row 5 */}
                <button
                  type="button"
                  onClick={() => appendToken('0')}
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-sm font-mono font-bold text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all cursor-pointer active:scale-95"
                >
                  0
                </button>
                <button
                  type="button"
                  onClick={() => appendToken('.')}
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-base font-mono font-bold text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-zinc-800 transition-all cursor-pointer active:scale-95"
                >
                  .
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleApplyEquals();
                    setIsOpen(false);
                  }}
                  className="col-span-2 min-h-[38px] rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-xs font-bold text-white shadow-md shadow-indigo-500/20 transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>= Apply ({evaluated.value !== null ? evaluated.value.toFixed(2) : '0.00'})</span>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
