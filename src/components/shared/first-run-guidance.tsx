'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, Languages, Receipt, Sparkles, Check, X, ArrowRight } from 'lucide-react';
import {
  getUserMoneyProfile,
  updateUserMoneyProfile,
  type UserMoneyProfile,
} from '@/lib/user-money-profile';

const FIRST_RUN_DISMISSED_KEY = 'kinova_first_run_dismissed';

interface FirstRunGuidanceProps {
  expenseCount: number;
  onLogSampleExpense?: (text: string) => void;
}

export function FirstRunGuidance({ expenseCount, onLogSampleExpense }: FirstRunGuidanceProps) {
  const [isDismissed, setIsDismissed] = useState(true);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [profile, setProfile] = useState<UserMoneyProfile | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const dismissed = localStorage.getItem(FIRST_RUN_DISMISSED_KEY);
    if (!dismissed && expenseCount < 3) {
      setIsDismissed(false);
    }
    setProfile(getUserMoneyProfile());
  }, [expenseCount]);

  if (isDismissed || expenseCount >= 3 || !profile) {
    return null;
  }

  const handleDismiss = () => {
    setIsDismissed(true);
    localStorage.setItem(FIRST_RUN_DISMISSED_KEY, 'true');
  };

  const handleSetLanguage = (lang: 'zh' | 'en' | 'ms' | 'auto') => {
    updateUserMoneyProfile({ language: lang });
    setProfile((prev) => (prev ? { ...prev, language: lang } : null));
    setStep(2);
  };

  const handleSetPayday = (day: number) => {
    updateUserMoneyProfile({ paydayDay: day });
    setProfile((prev) => (prev ? { ...prev, paydayDay: day } : null));
    setStep(3);
  };

  const handleSelectSample = (sample: string) => {
    if (onLogSampleExpense) {
      onLogSampleExpense(sample);
    }
    handleDismiss();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-white/90 dark:to-zinc-950 p-4 shadow-md space-y-3"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-xl bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 flex items-center justify-center font-bold text-xs">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <span>Welcome to Kinova</span>
                <span className="text-[10px] font-medium text-slate-500 dark:text-zinc-400">
                  · 3-step setup (Step {step} of 3)
                </span>
              </h3>
              <p className="text-[11px] text-slate-600 dark:text-zinc-400">
                Teach Kinova about you for personalized financial advice and tracking
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            title="Dismiss guide"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center gap-1.5">
          <div className={`h-1 flex-1 rounded-full transition-all ${step >= 1 ? 'bg-indigo-600 dark:bg-indigo-400' : 'bg-slate-200 dark:bg-zinc-800'}`} />
          <div className={`h-1 flex-1 rounded-full transition-all ${step >= 2 ? 'bg-indigo-600 dark:bg-indigo-400' : 'bg-slate-200 dark:bg-zinc-800'}`} />
          <div className={`h-1 flex-1 rounded-full transition-all ${step >= 3 ? 'bg-indigo-600 dark:bg-indigo-400' : 'bg-slate-200 dark:bg-zinc-800'}`} />
        </div>

        {/* Step 1: Language */}
        {step === 1 && (
          <div className="space-y-2 pt-1 animate-in fade-in duration-200">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-zinc-300">
              <Languages className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Step 1: Which language do you prefer Kinova to reply in?</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => handleSetLanguage('zh')}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border text-xs font-semibold transition-all ${
                  profile.language === 'zh'
                    ? 'border-indigo-500 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 shadow-sm'
                    : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:border-slate-300 dark:hover:border-zinc-700'
                }`}
              >
                <span>中文 (Chinese)</span>
                {profile.language === 'zh' && <Check className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={() => handleSetLanguage('en')}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border text-xs font-semibold transition-all ${
                  profile.language === 'en'
                    ? 'border-indigo-500 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 shadow-sm'
                    : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:border-slate-300 dark:hover:border-zinc-700'
                }`}
              >
                <span>English</span>
                {profile.language === 'en' && <Check className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={() => handleSetLanguage('ms')}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border text-xs font-semibold transition-all ${
                  profile.language === 'ms'
                    ? 'border-indigo-500 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 shadow-sm'
                    : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:border-slate-300 dark:hover:border-zinc-700'
                }`}
              >
                <span>Bahasa Melayu</span>
                {profile.language === 'ms' && <Check className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={() => handleSetLanguage('auto')}
                className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border text-xs font-semibold transition-all ${
                  profile.language === 'auto'
                    ? 'border-indigo-500 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 shadow-sm'
                    : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:border-slate-300 dark:hover:border-zinc-700'
                }`}
              >
                <span>Auto / Manglish</span>
                {profile.language === 'auto' && <Check className="h-3 w-3" />}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Payday */}
        {step === 2 && (
          <div className="space-y-2 pt-1 animate-in fade-in duration-200">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-zinc-300">
              <Calendar className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Step 2: When is your monthly payday? (Used for accurate cashflow forecast)</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {[25, 28, 30, 1].map((day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => handleSetPayday(day)}
                  className={`py-1.5 px-3 rounded-xl border text-xs font-semibold transition-all ${
                    profile.paydayDay === day
                      ? 'border-indigo-500 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 shadow-sm'
                      : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-300 hover:border-slate-300 dark:hover:border-zinc-700'
                  }`}
                >
                  Day {day} {day === 25 ? '(Common)' : day === 28 ? '(Gov / Banks)' : day === 1 ? '(1st)' : ''}
                </button>
              ))}
              <div className="flex items-center gap-1 text-xs text-slate-500">
                <span>or</span>
                <input
                  type="number"
                  min="1"
                  max="31"
                  placeholder="Day 1-31"
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (val >= 1 && val <= 31) handleSetPayday(val);
                  }}
                  className="w-20 h-8 rounded-lg border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-2 text-xs font-mono text-slate-900 dark:text-white text-center outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 3: First Expense Sample */}
        {step === 3 && (
          <div className="space-y-2 pt-1 animate-in fade-in duration-200">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-zinc-300">
              <Receipt className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>Step 3: Try recording your first expense! Tap a sample or type below:</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {['午餐 15', 'Mamak lunch 18', 'Shell petrol 60', 'Groceries 45'].map((sample) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => handleSelectSample(sample)}
                  className="py-1.5 px-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200 text-xs font-medium hover:bg-indigo-500/20 transition-all flex items-center gap-1 cursor-pointer"
                >
                  <span>{sample}</span>
                  <ArrowRight className="h-3 w-3 opacity-60" />
                </button>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
