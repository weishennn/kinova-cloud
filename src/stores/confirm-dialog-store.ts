'use client';

import { create } from 'zustand';
import React from 'react';

export interface ConfirmDialogOptions {
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'default';
  icon?: 'trash' | 'alert' | 'info';
}

interface ConfirmDialogState {
  isOpen: boolean;
  options: ConfirmDialogOptions;
  resolve: ((value: boolean) => void) | null;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  handleConfirm: () => void;
  handleCancel: () => void;
}

export const useConfirmStore = create<ConfirmDialogState>((set, get) => ({
  isOpen: false,
  options: {
    title: 'Are you sure?',
    description: '',
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    variant: 'danger',
    icon: 'trash',
  },
  resolve: null,
  confirm: (options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      set({
        isOpen: true,
        options: {
          confirmText: 'Confirm',
          cancelText: 'Cancel',
          variant: 'danger',
          icon: 'trash',
          ...options,
        },
        resolve,
      });
    });
  },
  handleConfirm: () => {
    const { resolve } = get();
    if (resolve) resolve(true);
    set({ isOpen: false, resolve: null });
  },
  handleCancel: () => {
    const { resolve } = get();
    if (resolve) resolve(false);
    set({ isOpen: false, resolve: null });
  },
}));

/**
 * Convenience helper callable anywhere (in hooks, event handlers, or async functions)
 */
export const confirmAction = (options: ConfirmDialogOptions): Promise<boolean> => {
  return useConfirmStore.getState().confirm(options);
};
