'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { 
  LayoutDashboard, ArrowLeftRight, TrendingUp, Receipt, 
  Plane, Wallet, PieChart, Settings, Plus, Sparkles 
} from 'lucide-react';
import { useAppStore } from '@/stores/app-store';

const NAV_ITEMS = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Transactions', href: '/transactions', icon: ArrowLeftRight },
  { name: 'Investments', href: '/investments', icon: TrendingUp },
  { name: 'Invoices & Tax', href: '/invoices', icon: Receipt },
  { name: 'Trip Tracker', href: '/trips', icon: Plane },
  { name: 'Monthly Budget', href: '/budget', icon: Wallet },
  { name: 'Analytics', href: '/analytics', icon: PieChart },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function DesktopSidebar() {
  const pathname = usePathname();
  const { setQuickAddOpen } = useAppStore();

  const activePath = pathname;

  return (
    <aside aria-label="Desktop Sidebar" className="w-64 border-r border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#090d16] p-6 flex flex-col justify-between hidden lg:flex shrink-0 min-h-screen sticky top-0">
      <div className="space-y-6">
        {/* Brand */}
        <div className="flex items-center">
          <img src="/kinova-header-logo.png" alt="Kinova" className="h-10 w-auto object-contain block" />
        </div>

        {/* Big Record Payment Button */}
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => setQuickAddOpen(true)}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-2xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white dark:text-white font-semibold text-sm shadow-xl shadow-indigo-500/25 transition-all cursor-pointer focus-visible:ring-2 focus-visible:ring-indigo-400"
          aria-label="Record Payment"
        >
          <Plus className="h-5 w-5 pointer-events-none" />
          <span className="pointer-events-none">Record Payment</span>
        </motion.button>

        {/* Navigation Items with smooth sliding active pill */}
        <nav aria-label="Main Navigation" className="space-y-1.5">
          {NAV_ITEMS.map((item) => {
            const isActive = activePath === item.href;
            return (
              <Link
                key={item.name}
                href={item.href}
                prefetch={true}
                aria-label={item.name}
                aria-current={isActive ? 'page' : undefined}
                className="relative block select-none rounded-xl focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                <motion.div
                  whileHover={{ x: isActive ? 0 : 4 }}
                  transition={{ type: 'spring' as const, stiffness: 400, damping: 25 }}
                  className={`relative z-10 flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    isActive
                      ? 'text-slate-950 dark:text-white font-semibold'
                      : 'text-slate-600 dark:text-zinc-400 hover:text-slate-950 dark:hover:text-white'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="desktop-sidebar-active"
                      className="absolute inset-0 bg-gradient-to-r from-indigo-500/20 to-purple-500/10 border border-indigo-500/35 rounded-xl shadow-[0_0_20px_rgba(99,102,241,0.15)] -z-10 pointer-events-none"
                      transition={{ type: 'spring' as const, stiffness: 450, damping: 32 }}
                    />
                  )}
                  <item.icon className={`h-4 w-4 shrink-0 transition-colors pointer-events-none ${isActive ? 'text-indigo-800 dark:text-indigo-400' : 'text-slate-600 dark:text-zinc-400'}`} />
                  <span className="relative z-10 pointer-events-none">{item.name}</span>
                </motion.div>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Footer Info */}
      <div className="p-3 rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white/90 dark:bg-zinc-900/40 text-xs text-slate-600 dark:text-zinc-400 space-y-1">
        <div className="flex items-center gap-2 text-slate-700 dark:text-zinc-300">
          <Sparkles className="h-3.5 w-3.5 text-indigo-800 dark:text-indigo-400" />
          <span className="font-medium text-[11px]">Google Drive Cloud Sync</span>
        </div>
        <p className="text-[10px] text-slate-600 dark:text-zinc-400">Real-time spreadsheet backup</p>
      </div>
    </aside>
  );
}
