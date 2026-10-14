import { create } from 'zustand';
import { GroupedInstallmentPlan } from '@/lib/installment-helper';
import { getLocalMonthString, getMonthDateRange } from '@/lib/date-helper';
import type { AiPrefill } from '@/types/ai-command';

interface AppState {
  // Active section
  activeTab: string;
  setActiveTab: (tab: string) => void;
  
  // Quick add dialog
  isQuickAddOpen: boolean;
  setQuickAddOpen: (open: boolean) => void;
  editTransaction: Record<string, unknown> | null;
  setEditTransaction: (transaction: Record<string, unknown> | null) => void;
  quickAddType: 'income' | 'expense' | null;
  setQuickAddType: (type: 'income' | 'expense' | null) => void;

  // AI drafts are handed to existing forms and must be reviewed before saving.
  aiPrefill: AiPrefill | null;
  setAiPrefill: (prefill: AiPrefill | null) => void;

  // Edit Installment Plan
  editInstallmentPlan: GroupedInstallmentPlan | null;
  setEditInstallmentPlan: (plan: GroupedInstallmentPlan | null) => void;
  
  // Active trip
  activeTripId: string | null;
  setActiveTripId: (id: string | null) => void;
  
  // Date range filter (global)
  dateRange: { from: string; to: string };
  setDateRange: (range: { from: string; to: string }) => void;

  // Active selected month/period across whole app session (defaults to current month on app load)
  selectedMonth: string;
  setSelectedMonth: (month: string) => void;
  
  // Kinova AI (Receipt price search & memory layer)
  isKinovaAIOpen: boolean;
  setKinovaAIOpen: (open: boolean) => void;

  // Settings cache
  settings: Record<string, string>;
  setSettings: (settings: Record<string, string>) => void;
  updateSetting: (key: string, value: string) => void;
}

// Current month in YYYY-MM format
const getCurrentMonthStr = () => getLocalMonthString();

// Default date range: current month
const getInitialDateRange = () => getMonthDateRange();

export const useAppStore = create<AppState>((set) => ({
  activeTab: 'dashboard',
  setActiveTab: (tab) => set({ activeTab: tab }),
  
  isQuickAddOpen: false,
  setQuickAddOpen: (open) => set({ isQuickAddOpen: open }),
  editTransaction: null,
  setEditTransaction: (transaction) => set({ editTransaction: transaction }),
  
  quickAddType: null,
  setQuickAddType: (type) => set({ quickAddType: type }),

  aiPrefill: null,
  setAiPrefill: (prefill) => set({ aiPrefill: prefill }),
  
  editInstallmentPlan: null,
  setEditInstallmentPlan: (plan) => set({ editInstallmentPlan: plan }),
  
  activeTripId: null,
  setActiveTripId: (id) => set({ activeTripId: id }),
  
  dateRange: getInitialDateRange(),
  setDateRange: (range) => set({ dateRange: range }),

  selectedMonth: getCurrentMonthStr(),
  setSelectedMonth: (month) => set({ selectedMonth: month }),
  
  isKinovaAIOpen: false,
  setKinovaAIOpen: (open) => set({ isKinovaAIOpen: open }),

  settings: {
    currency: 'MYR',
    theme: 'dark',
  },
  setSettings: (settings) => set({ settings }),
  updateSetting: (key, value) => 
    set((state) => ({ 
      settings: { ...state.settings, [key]: value } 
    })),
}));
