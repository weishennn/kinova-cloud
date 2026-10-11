'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, ArrowUpRight, Ellipsis, LayoutDashboard, Plus, PieChart, Receipt, Plane, Settings, TrendingDown, TrendingUp, Wallet, X } from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import { requestInvestmentTrade } from '@/lib/investment-trade-events';
import { CockpitModal, CockpitModalHeader } from '@/components/money-cockpit/cockpit-modal';

const secondaryLinks = [
  { label: 'Investments', href: '/investments', icon: TrendingUp },
  { label: 'Invoices & tax', href: '/invoices', icon: Receipt },
  { label: 'Trip tracker', href: '/trips', icon: Plane },
  { label: 'Monthly budget', href: '/budget', icon: Wallet },
  { label: 'Analytics', href: '/analytics', icon: PieChart },
  { label: 'Settings', href: '/settings', icon: Settings },
];

export function FloatingDock() {
  const pathname = usePathname();
  const { setQuickAddOpen, setQuickAddType } = useAppStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [investmentTradeMenuOpen, setInvestmentTradeMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const moreActionRef = useRef<HTMLButtonElement>(null);
  const isMoreRoute = secondaryLinks.some(({ href }) => pathname === href || pathname.startsWith(`${href}/`));
  const isInvestmentRoute = pathname === '/investments' || pathname.startsWith('/investments/');

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        moreActionRef.current?.focus({ preventScroll: true });
      }
    };
    const closeOnHistoryNavigation = () => setMenuOpen(false);
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('popstate', closeOnHistoryNavigation);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('popstate', closeOnHistoryNavigation);
    };
  }, [menuOpen]);

  const quickAdd = () => {
    setQuickAddType('expense');
    setQuickAddOpen(true);
  };

  const handlePrimaryAction = () => {
    if (isInvestmentRoute) {
      setMenuOpen(false);
      setInvestmentTradeMenuOpen((open) => !open);
      return;
    }
    setInvestmentTradeMenuOpen(false);
    quickAdd();
  };

  return (
    <>
    <div className="cockpit-dock-wrap" ref={menuRef}>
      <div className="cockpit-dock-brand" aria-hidden="true">
        <img src="/kinova-header-logo.png" alt="Kinova" className="h-9 w-auto object-contain block" />
      </div>
      {menuOpen && (
        <nav id="cockpit-more-menu" className="cockpit-more-menu" aria-label="More destinations">
          <div className="cockpit-more-head"><span>Go to</span><button type="button" onClick={() => setMenuOpen(false)} aria-label="Close navigation menu"><X size={16} /></button></div>
          {secondaryLinks.map(({ label, href, icon: Icon }) => (
            <Link href={href} key={href} onClick={() => { setMenuOpen(false); setInvestmentTradeMenuOpen(false); }} className="cockpit-more-link" aria-current={pathname === href ? 'page' : undefined}>
              <Icon size={17} aria-hidden="true" /><span>{label}</span><span aria-hidden="true">↗</span>
            </Link>
          ))}
        </nav>
      )}
      <nav className="cockpit-dock" aria-label="Main navigation">
        <Link href="/" onClick={() => { setMenuOpen(false); setInvestmentTradeMenuOpen(false); }} aria-current={pathname === '/' || pathname === '/redesign' ? 'page' : undefined} className={`cockpit-dock-link ${pathname === '/' || pathname === '/redesign' ? 'is-active' : ''}`}>
          <LayoutDashboard size={19} aria-hidden="true" /><span>Home</span>
        </Link>
        <Link href="/transactions" onClick={() => { setMenuOpen(false); setInvestmentTradeMenuOpen(false); }} aria-current={pathname === '/transactions' ? 'page' : undefined} className={`cockpit-dock-link ${pathname === '/transactions' ? 'is-active' : ''}`}>
          <ArrowLeftRight size={19} aria-hidden="true" /><span>Flow</span>
        </Link>
        <button
          ref={primaryActionRef}
          type="button"
          className={`cockpit-dock-add ${isInvestmentRoute ? 'is-trade-action' : ''}`}
          onClick={handlePrimaryAction}
          aria-label={isInvestmentRoute ? 'Choose a buy or sell trade' : 'Add expense'}
          aria-haspopup={isInvestmentRoute ? 'dialog' : undefined}
          aria-expanded={isInvestmentRoute ? investmentTradeMenuOpen : undefined}
          aria-controls={isInvestmentRoute ? 'cockpit-trade-menu' : undefined}
        >
          <Plus size={21} aria-hidden="true" /><span className="cockpit-dock-add-label">{isInvestmentRoute ? 'Trade' : 'Add expense'}</span>
        </button>
        <Link href="/analytics" onClick={() => { setMenuOpen(false); setInvestmentTradeMenuOpen(false); }} aria-current={pathname === '/analytics' ? 'page' : undefined} className={`cockpit-dock-link ${pathname === '/analytics' ? 'is-active' : ''}`}>
          <PieChart size={19} aria-hidden="true" /><span>Insights</span>
        </Link>
        <button ref={moreActionRef} type="button" className={`cockpit-dock-link ${menuOpen || isMoreRoute ? 'is-active' : ''}`} onClick={() => { setInvestmentTradeMenuOpen(false); setMenuOpen((open) => !open); }} aria-label="More destinations" aria-current={isMoreRoute ? 'page' : undefined} aria-expanded={menuOpen} aria-controls="cockpit-more-menu">
          <Ellipsis size={20} aria-hidden="true" /><span>More</span>
        </button>
      </nav>
    </div>
    <CockpitModal
      id="cockpit-trade-menu"
      isOpen={isInvestmentRoute && investmentTradeMenuOpen}
      onClose={() => setInvestmentTradeMenuOpen(false)}
      labelledBy="cockpit-trade-title"
      describedBy="cockpit-trade-description"
      size="compact"
      lockBodyScroll
    >
      <CockpitModalHeader
        title="Choose a trade"
        titleId="cockpit-trade-title"
        description="Select how you want to update your holdings."
        descriptionId="cockpit-trade-description"
        icon={<ArrowLeftRight size={20} />}
        onClose={() => setInvestmentTradeMenuOpen(false)}
        closeLabel="Close trade options"
      />
      <div className="cockpit-trade-menu-options mt-4">
        <button type="button" className="cockpit-trade-choice is-buy" onClick={() => { requestInvestmentTrade('BUY'); setInvestmentTradeMenuOpen(false); }}>
          <span className="cockpit-trade-choice-icon"><TrendingUp size={18} aria-hidden="true" /></span>
          <span className="cockpit-trade-choice-copy"><strong>Buy</strong><small>Add to your holdings</small></span>
          <ArrowUpRight className="cockpit-trade-choice-arrow" size={16} aria-hidden="true" />
        </button>
        <button type="button" className="cockpit-trade-choice is-sell" onClick={() => { requestInvestmentTrade('SELL'); setInvestmentTradeMenuOpen(false); }}>
          <span className="cockpit-trade-choice-icon"><TrendingDown size={18} aria-hidden="true" /></span>
          <span className="cockpit-trade-choice-copy"><strong>Sell</strong><small>Record units sold</small></span>
          <ArrowUpRight className="cockpit-trade-choice-arrow" size={16} aria-hidden="true" />
        </button>
      </div>
    </CockpitModal>
    </>
  );
}
