'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutDashboard, ArrowLeftRight, Plus, TrendingUp, Menu, Receipt, Plane, PieChart, Wallet, Settings } from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import { CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';

export function BottomNav() {
  const pathname = usePathname();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const { setQuickAddOpen } = useAppStore();

  const activePath = pathname;

  const tabs = [
    { name: 'Home', href: '/', icon: LayoutDashboard },
    { name: 'Transactions', href: '/transactions', icon: ArrowLeftRight },
  ];

  const rightTabs = [
    { name: 'Investments', href: '/investments', icon: TrendingUp },
  ];

  const moreItems = [
    { name: 'Invoices & Tax', icon: Receipt, href: '/invoices' },
    { name: 'Trips', icon: Plane, href: '/trips' },
    { name: 'Budget', icon: Wallet, href: '/budget' },
    { name: 'Analytics', icon: PieChart, href: '/analytics' },
    { name: 'Settings', icon: Settings, href: '/settings' },
  ];

  return (
    <>
      <nav
        aria-label="Mobile Bottom Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 px-4 pb-safe pt-2"
      >
        <div className="mx-auto max-w-lg rounded-full mb-3 px-3 py-1.5 flex items-center justify-between relative bg-white/90 dark:bg-[#090d16]/90 backdrop-blur-2xl border border-slate-200 dark:border-white/[0.12] shadow-[0_12px_44px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.15)]">

          <div className="flex items-center space-x-1 flex-1 justify-around">
            {tabs.map((tab) => {
              const isActive = activePath === tab.href;
              return (
                <Link
                  key={tab.name}
                  href={tab.href}
                  prefetch={true}
                  aria-label={tab.name}
                  aria-current={isActive ? 'page' : undefined}
                  className="relative min-w-[44px] min-h-[44px] p-2.5 rounded-full flex items-center justify-center transition-colors touch-manipulation select-none active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  {isActive && (
                    <motion.div
                      layoutId="bottom-nav-active"
                      className="absolute inset-0 bg-gradient-to-tr from-indigo-500/25 to-purple-500/20 border border-indigo-400/40 rounded-full shadow-[0_0_16px_rgba(99,102,241,0.35)] pointer-events-none"
                      transition={{ type: 'spring' as const, stiffness: 450, damping: 32 }}
                    />
                  )}
                  <tab.icon className={`w-5 h-5 relative z-10 transition-colors pointer-events-none ${isActive ? 'text-indigo-800 dark:text-indigo-300 drop-shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'}`} />
                </Link>
              );
            })}
          </div>

          {/* Floating Center Plus Action */}
          <div className="flex-shrink-0 px-2 relative -top-5">
            <motion.button
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              transition={{ type: 'spring' as const, stiffness: 400, damping: 20 }}
              onClick={() => setQuickAddOpen(true)}
              className="relative w-14 h-14 rounded-full bg-gradient-to-tr from-indigo-500 via-indigo-600 to-purple-600 flex items-center justify-center text-white dark:text-white shadow-2xl shadow-indigo-500/45 border border-slate-200 dark:border-white/30 cursor-pointer touch-manipulation focus-visible:ring-2 focus-visible:ring-white"
              title="Record Payment"
              aria-label="Record Payment"
            >
              <div className="absolute -inset-1 rounded-full bg-indigo-500/30 blur-md pointer-events-none" />
              <Plus className="w-7 h-7 relative z-10 pointer-events-none" />
            </motion.button>
          </div>

          <div className="flex items-center space-x-1 flex-1 justify-around">
            {rightTabs.map((tab) => {
              const isActive = activePath === tab.href;
              return (
                <Link
                  key={tab.name}
                  href={tab.href}
                  prefetch={true}
                  aria-label={tab.name}
                  aria-current={isActive ? 'page' : undefined}
                  className="relative min-w-[44px] min-h-[44px] p-2.5 rounded-full flex items-center justify-center transition-colors touch-manipulation select-none active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  {isActive && (
                    <motion.div
                      layoutId="bottom-nav-active"
                      className="absolute inset-0 bg-gradient-to-tr from-indigo-500/25 to-purple-500/20 border border-indigo-400/40 rounded-full shadow-[0_0_16px_rgba(99,102,241,0.35)] pointer-events-none"
                      transition={{ type: 'spring' as const, stiffness: 450, damping: 32 }}
                    />
                  )}
                  <tab.icon className={`w-5 h-5 relative z-10 transition-colors pointer-events-none ${isActive ? 'text-indigo-800 dark:text-indigo-300 drop-shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'}`} />
                </Link>
              );
            })}
            {(() => {
              const isMoreActive = moreItems.some(item => activePath === item.href);
              return (
                <button
                  onClick={() => setIsMoreOpen(true)}
                  className="relative min-w-[44px] min-h-[44px] p-2.5 rounded-full flex items-center justify-center transition-colors cursor-pointer touch-manipulation select-none active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-indigo-400"
                  title="More menus"
                  aria-label="More navigation menus"
                  aria-expanded={isMoreOpen}
                >
                  {isMoreActive && (
                    <motion.div
                      layoutId="bottom-nav-active"
                      className="absolute inset-0 bg-gradient-to-tr from-indigo-500/25 to-purple-500/20 border border-indigo-400/40 rounded-full shadow-[0_0_16px_rgba(99,102,241,0.35)] pointer-events-none"
                      transition={{ type: 'spring' as const, stiffness: 450, damping: 32 }}
                    />
                  )}
                  <Menu className={`w-5 h-5 relative z-10 transition-colors pointer-events-none ${isMoreActive ? 'text-indigo-800 dark:text-indigo-300 drop-shadow-[0_0_8px_rgba(99,102,241,0.5)]' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-200'}`} />
                </button>
              );
            })()}
          </div>

        </div>
      </nav>

      <AnimatePresence>
        {isMoreOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMoreOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[80]"
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="more-features-title"
              aria-describedby="more-features-description"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring' as const, damping: 28, stiffness: 300 }}
              className="fixed bottom-0 left-0 right-0 z-[80] bg-white/95 dark:bg-[#090d16]/95 backdrop-blur-3xl rounded-t-[2.5rem] p-6 pb-safe border-t border-slate-200 dark:border-white/15 shadow-2xl"
            >
              <CockpitModalHeader
                title="More features"
                titleId="more-features-title"
                description="Quick shortcuts to your financial tools."
                descriptionId="more-features-description"
                onClose={() => setIsMoreOpen(false)}
                closeLabel="Close navigation menu"
              />
              <div className="grid grid-cols-3 gap-3">
                {moreItems.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      prefetch={true}
                      onClick={() => setIsMoreOpen(false)}
                      className={`flex flex-col items-center justify-center gap-2.5 p-4 rounded-2xl transition-all touch-manipulation select-none active:scale-[0.95] min-h-[96px] ${
                        isActive
                          ? 'bg-gradient-to-b from-indigo-500/25 to-purple-500/15 text-white dark:text-white font-bold border border-indigo-500/40 shadow-lg shadow-indigo-500/15'
                          : 'bg-white/90 dark:bg-zinc-900/70 hover:bg-slate-100 dark:hover:bg-zinc-800/80 border border-slate-200 dark:border-white/[0.06] text-slate-700 dark:text-zinc-300 hover:text-slate-950 dark:hover:text-white'
                      }`}
                    >
                      <div className={`p-2.5 rounded-xl ${isActive ? 'bg-indigo-500/20 text-indigo-800 dark:text-indigo-300' : 'bg-slate-100 dark:bg-zinc-800/80 text-slate-700 dark:text-zinc-300'}`}>
                        <item.icon className="w-5 h-5" />
                      </div>
                      <span className="text-xs font-semibold text-center">{item.name}</span>
                    </Link>
                  );
                })}
              </div>

            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
