import React from 'react';
import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy — Kinova',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-zinc-100 py-16 px-4">
      <div className="max-w-2xl mx-auto rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-8 shadow-xl space-y-6">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <img src="/kinova-mark.png" alt="Kinova" className="h-10 w-10 object-contain" />
            <div>
              <h1 className="text-xl font-bold">Kinova Privacy Policy</h1>
              <p className="text-xs text-slate-500 dark:text-zinc-400">Personal Finance & Cloud Ledger</p>
            </div>
          </div>
          <Link
            href="/"
            className="text-xs font-semibold px-3 py-1.5 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20"
          >
            Back to App
          </Link>
        </div>

        <div className="space-y-4 text-sm leading-relaxed text-slate-700 dark:text-zinc-300">
          <section className="space-y-1.5">
            <h2 className="font-semibold text-slate-900 dark:text-white">1. Data Ownership & Google Drive Storage</h2>
            <p>
              Kinova is designed so that you own 100% of your financial data. When you sign in with Google, Kinova creates and accesses only the specific ledger spreadsheet (<code>Kinova CashFlow</code>) and receipt folders (<code>CashFlow Invoices</code> and <code>CashFlow Backups</code>) inside your own personal Google Drive using the <code>drive.file</code> scope.
            </p>
          </section>

          <section className="space-y-1.5">
            <h2 className="font-semibold text-slate-900 dark:text-white">2. What Information We Access</h2>
            <p>
              We access your basic Google profile (name, email address, and profile avatar) solely to authenticate your session and connect to your personal Google Drive ledger. Kinova does not read or access any other personal files in your Google Drive.
            </p>
          </section>

          <section className="space-y-1.5">
            <h2 className="font-semibold text-slate-900 dark:text-white">3. AI Expense & Receipt Parsing</h2>
            <p>
              When you use AI quick-entry or receipt OCR, the text or receipt image you submit is processed via Google Gemini API solely to extract structured transaction fields into your ledger.
            </p>
          </section>

          <section className="space-y-1.5">
            <h2 className="font-semibold text-slate-900 dark:text-white">4. Revoking Access</h2>
            <p>
              You may sign out at any time from Kinova Settings or revoke access directly from your Google Account Permissions page. All your spreadsheets and receipt files remain in your own Google Drive.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
