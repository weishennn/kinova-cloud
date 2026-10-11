'use client';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, ArrowDownCircle, ArrowUpCircle, Upload } from 'lucide-react';

export function FAB() {
  const [isOpen, setIsOpen] = useState(false);

  const actions = [
    { icon: ArrowDownCircle, label: 'Expense', color: 'text-red-800 dark:text-red-400', bg: 'bg-red-400/10' },
    { icon: ArrowUpCircle, label: 'Income', color: 'text-emerald-800 dark:text-emerald-400', bg: 'bg-emerald-400/10' },
    { icon: Upload, label: 'Upload Invoice', color: 'text-indigo-800 dark:text-indigo-400', bg: 'bg-indigo-400/10' },
  ];

  return (
    <div className="fixed bottom-24 right-6 z-40">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            className="absolute bottom-16 right-0 flex flex-col gap-3 mb-2 items-end"
          >
            {actions.map((action, i) => (
              <motion.button
                key={action.label}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ delay: i * 0.05 }}
                className="flex items-center gap-3 bg-card glass px-4 py-2 rounded-full shadow-lg"
              >
                <span className="text-sm font-medium">{action.label}</span>
                <div className={`p-2 rounded-full ${action.bg}`}>
                  <action.icon className={`w-5 h-5 ${action.color}`} />
                </div>
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <motion.button
        onClick={() => setIsOpen(!isOpen)}
        animate={{ rotate: isOpen ? 45 : 0 }}
        whileTap={{ scale: 0.9 }}
        className="w-14 h-14 rounded-full gradient-primary flex items-center justify-center text-slate-950 dark:text-white shadow-xl shadow-indigo-500/20"
      >
        <Plus className="w-8 h-8" />
      </motion.button>
    </div>
  );
}
