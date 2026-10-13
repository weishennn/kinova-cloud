# 💎 Kinova Cloud

A mobile-first Progressive Web App (PWA) for personal finance, wealth tracking, and tax relief management — powered by **Google Sheets & Google Drive** as your permanent, user-owned cloud database, **Google Gemini AI** for natural-language and screenshot bookkeeping, and **Trixpense** for group travel split-bills.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-149ECA?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38B2AC?logo=tailwind-css)

---

## ✨ Key Features

### 🔐 Multi-User Google Drive Cloud & Strict Account Isolation
- **One-Click Google OAuth 2.0**: Every user signs in with their own Google Account (`drive.file` scope). Kinova automatically provisions a private `Kinova CashFlow` spreadsheet, `CashFlow Invoices` folder, and `CashFlow Backups` folder inside **that user's own Google Drive**.
- **Strict Per-Account Storage Isolation**: Local SWR caches, offline mutation queues, and shortcut sessions are strictly scoped by authenticated email. Switching accounts or signing out verifies account-scoped backups before clearing active device state — preventing cross-account leakage or silent data loss.
- **Admin Owner Console**: The deployment owner (`ADMIN_EMAIL`) can monitor active users, view AI usage counts, and block/unblock accounts in real time from **Settings → Admin User Monitor & Blacklist**.
- **Local-Only Mode**: Optional browser-only storage mode with verified local backups for users who prefer not to connect a cloud account.

### 🤖 Gemini AI Bookkeeping & Multi-Key Load Balancing
- **Smart Quick Input (Text & Voice)**: Type or dictate natural phrases like *"Lunch nasi lemak 15.50"* or *"买 10 股 NVDA @ 135 USD"* to auto-parse amount, currency, category, date, and investment metadata.
- **Receipt Camera & Photo OCR**: Snap or upload receipts/PDFs to extract merchant, line items, SST/service tax, and auto-archive the file to Google Drive.
- **Receipt Price Memory**: Saved receipt scans keep each item's brand, product type, package size, quantity, and unit price with the expense. Tap the header search button or pull farther down from the top to open a full-page price history search; recent matches appear locally while older history loads. “Compare online” is an optional, user-triggered Google Search comparison with source links. It uses the existing server-side Gemini key and may consume paid API quota; the key is never sent to the browser.
- **Multi-Key Load Balancer & 429 Failover (`src/lib/gemini-key-pool.ts`)**: Configure 3 or more Gemini API keys (`GEMINI_API_KEY=key1,key2,key3` or `GEMINI_API_KEY_1`..`10`). Requests rotate via **Round-Robin** across healthy keys and transparently fail over in milliseconds within the same request if any key hits `HTTP 429` (quota exhausted) or `401/403`.

### 📲 iPhone Back Tap & Apple Pay Shortcut Auto-Recording
- **Double-Tap Back of iPhone**: Takes a screenshot of any payment confirmation screen (Touch 'n Go, Grab, MAE, ShopeePay, Apple Pay, bank transfer), sends it to `/api/shortcuts/ingest`, runs fast-fail Gemini Vision OCR, and records directly to the active user's Google Sheet.
- **Duplicate Protection & Undo**: Automatically skips duplicate submissions on the same day and provides a 15-minute one-tap Undo banner inside the app.
- **Recorded Timestamp & Backdate Indicator**: Automatically tracks the exact date and time each transaction was logged (e.g. `14:30 记` for same-day logs, or an amber `12/10 00:52 记` / `补记于 12/10 00:52` badge when logging past expenses).

### 🛡️ Zero-Drop Offline Sync & Optimistic Concurrency Control (OCC)
- **Instant `<10ms` Optimistic UI**: Adding, editing, or deleting a transaction updates the UI and local rolling cache immediately while syncing in the background.
- **Field-Level Concurrent Edit Detection (`src/lib/conflict-policy.ts`)**:
  - Edits to **different fields** on two devices merge automatically without overwriting each other.
  - Edits to the **same field** or **delete-vs-edit** collisions across devices are safely caught and sent to the **Settings Conflict Resolution Center**, allowing you to inspect both versions and choose **Keep Device Version** or **Keep Cloud Version**.
- **Cross-Month & Cross-Year Atomic Moves**: Changing a transaction's date across months or years adds it to the destination sheet first and removes it from the source sheet only after server verification.

### 📈 Wealth, 🇲🇾 LHDN Tax Relief & ✈️ Travel Suite
- **Investment Portfolio**: Track US/MY Stocks & Crypto (with live `GOOGLEFINANCE` formulas in Google Sheets), Fixed Deposits (tenure & maturity calculator), ASNB / Unit Trust, EPF / KWSP, and Emergency Savings.
- **Malaysia LHDN Tax Relief Tracker**: Built-in YA tax relief categories with automatic cap tracking, receipt attachment warnings, and progressive income tax estimation.
- **Recurring Commitments & Installment Plans**: Manage monthly subscriptions and multi-month 0% / interest-bearing installment schedules with versioned cloud envelopes.
- **Trip Tracker + Live Trixpense Sync**: Track multi-currency travel spending and link an 8-character **Trixpense** invite code to sync your personal share of group trip expenses automatically.

---

## 🏗️ Tech Stack

| Layer | Technology |
|:---|:---|
| **Framework** | Next.js 16 (App Router, Turbopack) |
| **Frontend** | React 19 + TypeScript 5 + Tailwind CSS v4 + Framer Motion |
| **State & Cache** | Zustand v5 + TanStack Query v5 + Account-Scoped SWR LocalStorage |
| **Cloud Database** | Google Sheets API v4 (User OAuth Drive) & Google Apps Script Bridge |
| **File & Backup Storage** | Google Drive API v3 (`CashFlow Invoices` & `CashFlow Backups`) |
| **AI Engine** | Google Gemini (`gemini-2.5-flash`) with Multi-Key Round-Robin Pool |
| **Testing** | Node.js Native Test Runner (`node --test tests/*.test.mjs`) |
| **Hosting & CI/CD** | Vercel (Push-to-Deploy via GitHub `kinova-cloud`) |

---

## ⚙️ Environment Variables (`.env.local` / Vercel)

Copy [`.env.example`](.env.example) to `.env.local` and configure the following server-side variables:

```env
# 1. Google OAuth 2.0 Multi-User Configuration
GOOGLE_CLIENT_ID=your_google_oauth_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
ADMIN_EMAIL=your_admin_email@gmail.com
AUTH_SECRET=your_64_char_random_hex_secret

# 2. Gemini API Keys (Supports 1 or 3+ keys for Round-Robin Load Balancing & 429 Failover)
# Option A: Comma-separated in GEMINI_API_KEY
GEMINI_API_KEY=key1,key2,key3
# Option B: Or numbered keys GEMINI_API_KEY_1, GEMINI_API_KEY_2, GEMINI_API_KEY_3...
GEMINI_MODEL=gemini-2.5-flash
# Optional model override for user-requested web price comparisons (defaults to gemini-2.5-flash)
GEMINI_PRICE_SEARCH_MODEL=gemini-2.5-flash

# 3. Admin Google Apps Script Bridge & Shortcut Token
APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
APPS_SCRIPT_API_KEY=your_apps_script_api_key
CASHFLOW_PROXY_TOKEN=your_proxy_token
KINOVA_SHORTCUT_TOKEN=your_shortcut_token

# 4. Optional Trixpense Integration
NEXT_PUBLIC_SPLITWISE_APP_URL=https://your-trixpense-url.vercel.app
```

> ⚠️ **Security Note**: Never commit `.env.local` or raw API keys to Git. Configure production secrets directly in **Vercel Dashboard → Settings → Environment Variables**.

---

## 🚀 Getting Started Locally

```bash
# 1. Install dependencies
npm install

# 2. Run development server (http://localhost:3000)
npm run dev

# 3. Run the unit & regression test suite (49 tests)
node --test tests/*.test.mjs

# 4. Build for production
npm run build
```

---

## 🔄 Sync vs. Force Full Sync

- **Normal Sync (`Sync Now` / Auto Sync)**: Flushes pending local mutations (new/edited/deleted rows, recurring rules, installment plans, settings) to Google Sheets and refreshes the active month cache. Fast and incremental for everyday use.
- **Force Full Sync (`Settings → Force Full Sync to Google Sheet`)**: Reconciles and rebuilds all spreadsheet tabs and formulas (`Overview` annual/monthly `SUMIFS` dashboard, `Portfolio` live `GOOGLEFINANCE` rows, `Trades`, `Recurring`, `Installments`, `Trips`, and `Settings`). Use only when you need to repair or regenerate sheet tabs/formulas.

---

## 📁 Project Structure

```text
cashflow/
├── apps-script/                  # Google Apps Script backend for Admin ledger & backups
│   ├── Code.gs                   # Main API bridge, idempotency ledger & tombstones
│   ├── Setup.gs                  # Sheet initialization & Overview/Portfolio formulas
│   └── Backups.gs                # Weekly & pre-migration Google Drive snapshot engine
├── src/
│   ├── app/
│   │   ├── (dashboard)/          # Transactions, Investments, Budget, Trips, Invoices, Analytics, Settings
│   │   └── api/                  # Server routes: Google OAuth, Sheets proxy, Gemini AI, iOS Shortcuts
│   ├── components/
│   │   ├── money-cockpit/        # Dashboard cockpit UI, Money Orbit & navigation
│   │   ├── dashboard/            # Recurring commitments, Installments, Income Advisor
│   │   ├── settings/             # Google Account status & Admin User Monitor / Blacklist
│   │   └── shared/               # RecordModal, TransactionDetailModal, SmartQuickInput
│   ├── hooks/                    # useTransactions, useSheets, useSyncStatus
│   ├── lib/
│   │   ├── google-sheets-user-engine.ts  # Direct per-user Google Sheets/Drive OAuth engine
│   │   ├── gemini-key-pool.ts            # Multi-key Gemini load balancer & 429 failover
│   │   ├── shortcut-draft-store.ts       # iOS Back Tap / Apple Pay OCR & auto-recording
│   │   ├── cache-manager.ts              # Account-scoped 60-day SWR cache & offline queue
│   │   ├── conflict-policy.ts            # Optimistic Concurrency Control (OCC) & field merge
│   │   └── lhdn-tax-helper.ts            # Malaysia LHDN tax relief rules & calculators
│   └── stores/                   # Zustand UI & confirm dialog stores
└── tests/                        # Node.js regression tests (sync, OCC, auth, AI pool, shortcuts)
```

---

## 📄 License

MIT
