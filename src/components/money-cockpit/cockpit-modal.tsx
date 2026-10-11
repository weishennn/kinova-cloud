'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';

type CockpitModalProps = {
  isOpen: boolean;
  onClose: () => void;
  id?: string;
  labelledBy: string;
  describedBy?: string;
  size?: 'compact' | 'standard' | 'wide';
  lockBodyScroll?: boolean;
  className?: string;
  children: ReactNode;
};

type CockpitModalHeaderProps = {
  title: string;
  titleId: string;
  description?: string;
  descriptionId?: string;
  icon?: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  closeLabel?: string;
};

export function CockpitModal({
  isOpen,
  onClose,
  id,
  labelledBy,
  describedBy,
  size = 'standard',
  lockBodyScroll = true,
  className = '',
  children,
}: CockpitModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useLockBodyScroll(lockBodyScroll && isOpen);

  useEffect(() => {
    if (!isOpen) return;

    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    wasOpenRef.current = true;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    return () => {
      window.cancelAnimationFrame(frame);
      if (wasOpenRef.current) {
        const target = returnFocusRef.current;
        wasOpenRef.current = false;
        window.requestAnimationFrame(() => {
          if (!document.querySelector('[role="dialog"]')) {
            target?.focus({ preventScroll: true });
          }
        });
      }
    };
  }, [isOpen]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="cockpit-modal-overlay">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="cockpit-modal-backdrop fixed inset-0"
            aria-hidden="true"
            onClick={onClose}
          />
          <motion.div
            ref={dialogRef}
            id={id}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: 'spring', damping: 28, stiffness: 350 }}
            className={`cockpit-modal-frame cockpit-modal-frame-${size} ${className}`.trim()}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function CockpitModalHeader({
  title,
  titleId,
  description,
  descriptionId,
  icon,
  onClose,
  closeDisabled = false,
  closeLabel = 'Close dialog',
}: CockpitModalHeaderProps) {
  return (
    <header className="cockpit-modal-header">
      <div className="cockpit-modal-heading">
        {icon && <span className="cockpit-modal-icon" aria-hidden="true">{icon}</span>}
        <div className="cockpit-modal-heading-copy">
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
      </div>
      <button type="button" className="cockpit-modal-close" onClick={onClose} aria-label={closeLabel} disabled={closeDisabled}>
        <X size={19} aria-hidden="true" />
      </button>
    </header>
  );
}
