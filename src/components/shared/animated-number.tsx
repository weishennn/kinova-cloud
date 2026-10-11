'use client';

import { useEffect, useRef } from 'react';

type AnimatedNumberProps = {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  showPlus?: boolean;
  formatValue?: (value: number) => string;
  animateOnMount?: boolean;
};

function formatNumber(value: number, prefix: string, suffix: string, decimals: number, showPlus: boolean) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const sign = showPlus && safeValue > 0 ? '+' : '';

  return `${sign}${prefix}${safeValue.toLocaleString('en-MY', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}${suffix}`;
}

/**
 * Smoothly transitions numeric values without re-rendering React on every frame.
 * This is intentionally limited to key summary values, not dense data tables.
 */
export function AnimatedNumber({
  value,
  prefix = 'RM ',
  suffix = '',
  decimals = 2,
  showPlus = false,
  formatValue,
  animateOnMount = false,
}: AnimatedNumberProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const previousValueRef = useRef(animateOnMount ? 0 : value);

  useEffect(() => {
    const start = Number.isFinite(previousValueRef.current) ? previousValueRef.current : 0;
    const end = Number.isFinite(value) ? value : 0;
    const format = (current: number) => formatValue
      ? formatValue(current)
      : formatNumber(current, prefix, suffix, decimals, showPlus);
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

    if (prefersReducedMotion) {
      if (spanRef.current) spanRef.current.textContent = format(end);
      previousValueRef.current = end;
      return;
    }

    const duration = 600;
    const startTime = performance.now();
    let frameId: number;
    let currentValue = start;

    const animate = (currentTime: number) => {
      const progress = Math.min((currentTime - startTime) / duration, 1);
      // easeOutExpo keeps the responsive jump while settling gently at the final value.
      const ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      currentValue = start + (end - start) * ease;

      if (spanRef.current) spanRef.current.textContent = format(currentValue);

      if (progress < 1) {
        frameId = requestAnimationFrame(animate);
      } else {
        previousValueRef.current = end;
        if (spanRef.current) spanRef.current.textContent = format(end);
      }
    };

    frameId = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frameId);
      previousValueRef.current = currentValue;
    };
  }, [value, prefix, suffix, decimals, showPlus, formatValue]);

  return (
    <span ref={spanRef} className="font-mono tabular-nums tracking-tight">
      {formatValue ? formatValue(value) : formatNumber(value, prefix, suffix, decimals, showPlus)}
    </span>
  );
}
