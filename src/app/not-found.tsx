'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Compass, Home, ArrowLeftRight, TrendingUp, Sparkles, RefreshCw } from 'lucide-react';

export default function NotFound() {
  const router = useRouter();
  const [countdown, setCountdown] = useState(4);
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setIsRedirecting(true);
          router.replace('/');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [router]);

  const handleHardRefresh = () => {
    if (typeof window !== 'undefined') {
      window.location.href = '/';
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl border border-indigo-500/20 bg-slate-900/90 dark:bg-zinc-950/90 backdrop-blur-2xl p-6 sm:p-8 text-center shadow-2xl space-y-5">
        {/* Animated Compass / Radar Icon */}
        <div className="relative mx-auto w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shadow-inner">
          <Compass className="w-8 h-8 animate-spin" style={{ animationDuration: '10s' }} />
          <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-indigo-500"></span>
          </span>
        </div>

        {/* Copy */}
        <div className="space-y-2">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/25 text-indigo-300 text-xs font-mono font-medium">
            <span>HTTP 404 · 找不到页面</span>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-white">
            您访问的页面不存在或已变更
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 leading-relaxed max-w-xs mx-auto">
            系统将在 <span className="font-bold text-indigo-400 font-mono text-sm">{countdown}</span> 秒后自动返回首页控制台。
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5 pt-2">
          <Link
            href="/"
            className="w-full sm:w-auto flex-1 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition-all cursor-pointer"
          >
            <Home className="w-4 h-4" />
            <span>{isRedirecting ? '正在返回首页…' : '立即返回首页'}</span>
          </Link>

          <button
            type="button"
            onClick={handleHardRefresh}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold border border-white/10 transition-all cursor-pointer"
            title="清除当前缓存并刷新到首页"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>重置刷新</span>
          </button>
        </div>

        {/* Quick Links to Core Sections */}
        <div className="pt-4 border-t border-white/10 space-y-2">
          <p className="text-[11px] text-slate-400 font-medium">常用快捷入口：</p>
          <div className="grid grid-cols-3 gap-2">
            <Link
              href="/transactions"
              className="flex flex-col items-center justify-center p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 text-slate-300 hover:text-white transition-all text-[11px]"
            >
              <ArrowLeftRight className="w-4 h-4 mb-1 text-slate-400" />
              <span>记账流水</span>
            </Link>
            <Link
              href="/receipt-prices"
              className="flex flex-col items-center justify-center p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 text-slate-300 hover:text-white transition-all text-[11px]"
            >
              <Sparkles className="w-4 h-4 mb-1 text-indigo-400" />
              <span>Kinova AI</span>
            </Link>
            <Link
              href="/investments"
              className="flex flex-col items-center justify-center p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 text-slate-300 hover:text-white transition-all text-[11px]"
            >
              <TrendingUp className="w-4 h-4 mb-1 text-emerald-400" />
              <span>资产投资</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
