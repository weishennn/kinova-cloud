# 📘 CashFlow 记账 — Comprehensive Developer & AI Architecture Guide

> **Target Audience**: Human developers, DevOps engineers, and AI models (Claude, ChatGPT, Gemini, Antigravity, Cursor) working on or maintaining this codebase.  
> **Key Goal**: Provide a single, complete, zero-ambiguity reference for the system architecture, code structure, deployment pipelines, cloud synchronization, and development rules.

---

## 📑 Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Repository & GitHub Workflow](#3-repository--github-workflow)
4. [Production Deployment (Vercel)](#4-production-deployment-vercel)
5. [Permanent Source of Truth (Google Sheets)](#5-permanent-source-of-truth-google-sheets)
6. [Device Cache & 60-Day Expiry Engine (`src/lib/cache-manager.ts`)](#6-device-cache--60-day-expiry-engine-srclibcache-managerts)
7. [Sheets Data Layer & Zero-Drop Mutations (`src/lib/sheets-data.ts`)](#7-sheets-data-layer--zero-drop-mutations-srclibsheets-datats)
8. [Codebase Anatomy & File Walkthrough](#8-codebase-anatomy--file-walkthrough)
9. [Special Features & Core Engines](#9-special-features--core-engines)
   - 9.1 [Month-by-Month Installment Engine](#91-month-by-month-installment-engine)
   - 9.2 [Tax Relief & Receipt Claiming (Google Drive)](#92-tax-relief--receipt-claiming-google-drive)
   - 9.3 [PIN Security & Trusted Device Flow](#93-pin-security--trusted-device-flow)
   - 9.4 [AI Expense Parser API](#94-ai-expense-parser-api)
10. [Automated Testing & Quality Assurance](#10-automated-testing--quality-assurance)
11. [Golden Rules for AI Models & Developers](#11-golden-rules-for-ai-models--developers)
12. [Troubleshooting & Common Pitfalls](#12-troubleshooting--common-pitfalls)

---

## 1. System Architecture Overview

CashFlow is designed as a **Google Sheets Source-of-Truth (SOT) Progressive Web App (PWA)** with a smart **rolling 60-day device cache**:

```mermaid
flowchart TD
    User([User Device / PWA / iPhone Safari]) -->|HTTPS / Next.js 16 UI| Frontend[Next.js App Router Frontend]

    subgraph Client Architecture
        Frontend --> Auth[AuthProvider PIN & Trusted Device]
        Frontend --> State[Zustand Global Store]
        Frontend --> CacheMgr[Cache Manager: 60-Day Rolling Window & Pruner]
        Frontend --> PendingQ[Durable Offline Mutation Queue]
        Frontend --> SheetsData[Sheets Data Layer: sheets-data.ts]
    end

    subgraph Permanent Cloud Source of Truth (SOT)
        SheetsData -->|HTTPS Web App REST Bridge| GAS[Google Apps Script: Code.gs]
        GAS --> Sheets[(Google Sheets: Permanent Multi-Year Ledger)]
        GAS --> Drive[(Google Drive: CashFlow_Receipts)]
    end

    subgraph Hosting & CI/CD
        GitHub[GitHub: weishennn/kinova] -->|Webhook on push to main| Vercel[Vercel CI/CD Build & Edge Hosting]
    end
```

### Why this architecture?
1. **Google Sheets as Sole Permanent SOT**: All historical transactions, stock trades, travel logs, and cloud settings reside permanently in your personal Google Drive spreadsheet. You have 100% data ownership, spreadsheet auditability, and zero risk of vendor lock-in.
2. **Rolling 60-Day Device Cache**: Browsers (especially Mobile Safari) impose tight storage limits (e.g. 5MB quota). Rather than downloading years of historical data to the phone, the device caches only the **current month and previous two months** (~60–90 days). Older history is loaded from Google Sheets **on demand**.
3. **Protected Settings & Zero Silent Drops**: Critical configuration (installment plans, recurring rules, budget caps, PIN) is permanently protected from cache expiry. Any mutations made offline are stored in a persistent pending queue and retried until Google Sheets confirms receipt.

---

## 2. Technology Stack

| Domain | Technology | Version | Purpose |
| :--- | :--- | :--- | :--- |
| **Framework** | Next.js (App Router, Turbopack) | `16.3.5` | React server/client framework |
| **Language** | TypeScript | `^5.0` | Strict type safety |
| **UI Library** | React | `19.2.8` | Component rendering |
| **Styling** | Tailwind CSS + `@tailwindcss/postcss` | `^4.0` | Modern responsive utility classes |
| **Component Primitives** | Radix UI (`@radix-ui/*`) | Latest | Accessible modal, dialog, dropdown, tabs |
| **State Management** | Zustand | `^5.0` | Lightweight global UI state |
| **Data Fetching** | TanStack React Query | `^5.103` | Client caching, revalidation, optimistic updates |
| **Animations** | Framer Motion | `^13.4` | Smooth mobile transitions and page switches |
| **Icons** | Lucide React | `^1.47` | Clean SVG financial and dashboard icons |
| **Charts** | Recharts | `^3.10` | Responsive financial trend & category charts |
| **Toasts** | Sonner | `^2.0` | Smooth stacked notifications |
| **Permanent SOT** | Google Sheets (Apps Script Bridge) | V8 Runtime | Multi-month ledger tabs & formulas |
| **File Storage** | Google Drive | Cloud REST | Encrypted receipt & invoice archiving |
| **Testing** | Puppeteer Core + MS Edge | `^25.12` | Headless full-flow end-to-end testing |
| **Deployment** | Vercel | Production | Automatic build, edge delivery, HTTPS |

---

## 3. Repository & GitHub Workflow

- **Remote URL**: `https://github.com/weishennn/kinova.git`
- **Main Production Branch**: `main`

### Standard Development & Push Cycle

Whenever you or an AI agent make any changes, always follow this strict sequence:

```powershell
# 1. Check current workspace status
git status

# 2. Verify compilation & build integrity
npm run build

# 3. (Optional but recommended) Run full automated UI tests
npm run test:e2e

# 4. Stage your changes
git add -A

# 5. Commit with standard Conventional Commit messages
git commit -m "feat(module): description of feature or fix"

# 6. Push directly to production branch
git push origin main
```

> **Note**: Committing and pushing to `main` immediately triggers an automatic deployment webhook on Vercel.

---

## 4. Production Deployment (Vercel)

### How Vercel Works with this Project
1. **Webhook Detection**: Vercel monitors the `weishennn/kinova` repository. As soon as a commit lands on `main`, Vercel spawns a production build container.
2. **Build Command**: Runs `next build` with Turbopack.
3. **Edge Optimization**: Static pages are pre-rendered at the edge; serverless API endpoints (e.g. `/api/ai/parse-expense`, `/api/stocks/quote`) are packaged as Vercel Serverless functions.
4. **Zero-Downtime Deployment**: Once the build passes, traffic shifts to the new deployment URL instantaneously.

### Required Environment Variables in Vercel
Go to **Vercel Dashboard → Your Project → Settings → Environment Variables**:

| Variable Name | Required? | Example / Purpose |
| :--- | :--- | :--- |
| `APPS_SCRIPT_URL` | **Yes for proxy mode** | Server-only Google Apps Script `/exec` URL |
| `APPS_SCRIPT_API_KEY` | **Yes for proxy mode** | Must match Apps Script `API_KEY` Script Property |
| `CASHFLOW_PROXY_TOKEN` | **Yes for proxy mode** | Random token with at least 32 characters; enter it on each trusted device |
| `NEXT_PUBLIC_APPS_SCRIPT_URL` | Direct mode only | Browser endpoint URL; not used by the authenticated server proxy |
| `NEXT_PUBLIC_APP_PIN` | Optional | Custom 4-digit PIN (defaults to `1214`) |
| `GEMINI_API_KEY` | Optional | Google Gemini API key for natural language expense parsing |

---

## 5. Permanent Source of Truth (Google Sheets)

### Sheet Layout & Naming Convention
The spreadsheet automatically organizes data across several tabs:
1. **Monthly Transaction Tabs**: Formatted strictly as `YYYY-MM` (e.g. `2026-08`, `2026-09`, `2026-10`).
   - Headers: `Id`, `Date`, `Type`, `Category`, `SubCategory`, `Description`, `Amount`, `Currency`, `TripTag`, `ReceiptUrl`, `Notes`.
2. **Static Tabs**:
   - `Overview`: Monthly income vs expense aggregation and net growth.
   - `Portfolio`: Aggregated asset holdings, average cost, current price, and unrealized P&L (`GOOGLEFINANCE`).
   - `Trades`: Raw stock/crypto transactions.
   - `Trips`: Travel budgets and tags.
   - `Recurring`: Fixed monthly commitments.
   - `Invoices`: Receipt claims and URLs.
   - `Settings`: User preferences and synchronized settings backup.

### Google Apps Script Web App (`apps-script/Code.gs`)
- **`doGet(e)`**: Handles read operations (`getAllTransactions`, `getMonthList`, `getSheetData`, `getPortfolio`, `getSettings`, `getFiles`).
- **`doPost(e)`**: Handles mutations (`addRow`, `updateRow`, `deleteRow`, `uploadFile`, `deleteFile`, `syncAllSheets`).
- **File Storage**: `uploadFile` decodes base64 image strings and writes them into a Google Drive folder named `CashFlow_Receipts`. It sets the sharing permission to anyone with link and returns the Google Drive web URL.

---

## 6. Device Cache & 60-Day Expiry Engine (`src/lib/cache-manager.ts`)

To guarantee blistering mobile speed without risking device storage crashes or stale data:

1. **Rolling 60-Day Window**:
   - `getRollingWindowMonths(3)` computes `[Current Month, Month - 1, Month - 2]` (e.g. October, September, August 2026).
   - Only transactions within this 3-month window are retained in device `localStorage`.
2. **Cache Expiry & Pruning (`pruneExpiredCache`)**:
   - Out-of-window month data and cache entries older than 60 days (`CACHE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000`) are automatically pruned.
   - Cache cleanup runs in a low-priority background callback on application startup.
3. **Protected Storage Keys (Whitelisted Never-Expire)**:
   - `cashflow_currency`
   - `cashflow_custom_api_url`
   - `cashflow_installment_plans`
   - `cashflow_recurring_commitments`
   - `cashflow_category_caps`
   - `cashflow_monthly_budget`
   - `cashflow_baseline_income`
   - `cashflow_emergency_reserve`
   - `cashflow_pending_queue`
   - `cashflow_last_synced_at`
   - `cashflow_custom_pin`
   - `cashflow_trusted_device`

---

## 7. Sheets Data Layer & Zero-Drop Mutations (`src/lib/sheets-data.ts`)

`sheetsData` abstracts all interactions with Google Sheets and the local cache:

### 1. Smart Reads (`fetchUnifiedTransactions`)
- First loads active months (rolling 3-month window) from local cache for sub-10ms UI startup.
- Fetches fresh data from Google Sheets in the background.
- If viewing historical months (e.g., 2025-01), loads them **on demand** directly from Google Sheets without polluting long-term device storage.

### 2. Zero-Drop Optimistic Mutations (`addRow`, `updateRow`, `deleteRow`)
- Applies changes optimistically to local UI state and cache immediately.
- Dispatches HTTP call to Google Apps Script.
- If offline or request fails:
  - Mutation is persisted into `cashflow_pending_queue` (`enqueuePendingMutation`).
  - Optimistic overlay keeps UI updated (`applyPendingMutations`).
  - User is notified via toast that change is queued safely.
- When network reconnects (`online` event), `flushPendingQueue()` automatically retries all pending items until confirmed by Google Sheets.

---

## 8. Codebase Anatomy & File Walkthrough

```
cashflow/
├── apps-script/
│   ├── Code.gs                  # Google Apps Script API engine (doGet, doPost, Drive uploads)
│   ├── Setup.gs                 # Script to create initial spreadsheet sheets & headers
│   └── appsscript.json          # Google Apps Script manifest
│
├── scripts/
│   └── test_ui_flow.js          # Full end-to-end headless browser test suite
│
├── public/                      # Static icons, manifest.json for PWA installation
│
├── src/
│   ├── middleware.ts            # Next.js request middleware
│   │
│   ├── app/                     # App Router root
│   │   ├── layout.tsx           # Global HTML root, ThemeProvider, Toaster, AuthProvider
│   │   ├── globals.css          # Tailwind CSS v4 directives, OLED dark theme palette
│   │   ├── page.tsx             # Landing / dashboard index redirect
│   │   │
│   │   ├── (dashboard)/         # Grouped dashboard routes sharing navigation shell
│   │   │   ├── layout.tsx       # Desktop sidebar, Mobile bottom nav, AppHeader, FAB
│   │   │   ├── transactions/    # Main bookkeeping ledger, monthly calendar, search
│   │   │   ├── budget/          # Category budget allocations & visual progress
│   │   │   ├── investments/     # Stock & crypto portfolio tracker, trade logger
│   │   │   ├── trips/           # Travel expense manager with multi-currency tags
│   │   │   ├── invoices/        # Tax receipt organizer & multi-month zip export
│   │   │   ├── analytics/       # Recharts spending trends & category breakdown
│   │   │   └── settings/        # Cloud sync, 60-day cache manager, PIN, preferences
│   │   │
│   │   └── api/                 # Next.js API Routes (Serverless)
│   │       ├── ai/parse-expense/route.ts  # Gemini AI expense NLP parser
│   │       ├── currency/rates/route.ts    # FX exchange rates
│   │       ├── stocks/quote/route.ts      # Live stock quotes
│   │       └── stocks/search/route.ts     # Ticker search helper
│   │
│   ├── components/
│   │   ├── auth-provider.tsx    # 4-digit PIN lock screen & trusted device manager
│   │   ├── providers.tsx        # TanStack Query Client provider wrapper
│   │   │
│   │   ├── shared/              # Reusable core UI dialogs and navigation
│   │   │   ├── app-shell.tsx              # App container layout
│   │   │   ├── app-header.tsx             # Top header bar (brand, live sync pill, sync button)
│   │   │   ├── bottom-nav.tsx             # Mobile navigation bar with zero lag
│   │   │   ├── desktop-sidebar.tsx        # Desktop collapsible navigation sidebar
│   │   │   ├── record-modal.tsx           # Unified entry modal for Expense/Income/Installment
│   │   │   ├── transaction-detail-modal.tsx # Detail card for transaction & edit launcher
│   │   │   ├── edit-installment-modal.tsx # Edit existing installment plan parameters
│   │   │   ├── smart-quick-input.tsx      # Natural language quick input bar
│   │   │   └── fab.tsx                    # Floating "+" Action Button
│   │   │
│   │   ├── dashboard/           # Specialized dashboard widgets
│   │   │   ├── installment-dashboard.tsx  # Installment plan progress cards
│   │   │   ├── income-advisor.tsx         # Income distribution and savings advisor
│   │   │   └── recurring-commitments.tsx  # Fixed recurring bill tracker
│   │   │
│   │   ├── invoices/            # Tax receipt claims widgets
│   │   │   ├── claims-calendar.tsx        # Calendar view of uploaded receipts
│   │   │   └── date-range-download-modal.tsx # Multi-month receipt zip downloader
│   │   │
│   │   └── ui/                  # shadcn/ui accessible primitives (Button, Dialog, Card, etc.)
│   │
│   ├── hooks/                   # Custom data & sync hooks
│   │   ├── useTransactions.ts   # Fetch, filter, and mutate transactions
│   │   ├── useSheets.ts         # Query sheets, add rows, update rows, delete rows
│   │   ├── useSyncStatus.ts     # Real-time connection & last synced indicator
│   │   ├── useCloudSettingsSync.ts # Two-way settings synchronization with Google Sheets
│   │   ├── useInvestments.ts    # Portfolio holdings and trade history
│   │   ├── useInvoices.ts       # Tax receipts and invoice queries
│   │   ├── useTrips.ts          # Travel logs and budget tracking
│   │   └── useCategories.ts     # Category list and icon mappings
│   │
│   ├── lib/                     # Utilities and backend connectors
│   │   ├── sheets-data.ts       # Unified Google Sheets data layer with offline queue
│   │   ├── cache-manager.ts     # 60-day rolling window, cache pruner, pending mutations
│   │   ├── sheets-api.ts        # Google Apps Script REST client
│   │   ├── cloud-settings-sync.ts # Settings backup & restore to Google Sheets
│   │   ├── installment-helper.ts# Installment schedule, interest, and auto-record logic
│   │   ├── claim-helper.ts      # Tax relief categories & receipt naming conventions
│   │   ├── image-compressor.ts  # Client-side JPEG compression before upload
│   │   ├── tax.ts               # Malaysian progressive tax calculations & relief caps
│   │   ├── currency.ts          # Multi-currency conversions & formatting
│   │   └── utils.ts             # Tailwind class merging (`cn`)
│   │
│   ├── stores/
│   │   └── app-store.ts         # Zustand store (active tabs, modal states, filters)
│   │
│   └── types/                   # TypeScript interfaces (Transaction, Trade, Trip, Sheet)
```

---

## 9. Special Features & Core Engines

### 9.1 Month-by-Month Installment Engine

> [!IMPORTANT]
> **Strict Business Rule**: Installments must **NEVER** pre-fill future months into the transactions table or Google Sheets!  
> Future months are scheduled in storage (`cashflow_installment_plans`) and are recorded only when each month becomes due.

1. **Creation**: When a user creates an installment (e.g. 6-month plan starting today):
   - The master plan is saved to storage (`cashflow_installment_plans`).
   - **Only Month 1** (e.g. `Logitech Mouse (Installment 1/6)`) is recorded in the transactions database.
2. **Auto-Recording**: Whenever the app loads, `checkAndAutoRecordInstallments` checks if a new month has arrived:
   - If today is ≥ the due date for Month 2, it records Month 2.
   - It will never duplicate an already recorded month index.
3. **Tenure & Modals**:
   - Supports tenure from **1 to 120 months**.
   - Tapping an installment plan card opens `EditInstallmentModal`, allowing users to adjust tenure, start date, or delete cleanly.

### 9.2 Tax Relief & Receipt Claiming (Google Drive)

1. When a user uploads a receipt, `image-compressor.ts` compresses the image to <800KB.
2. `claim-helper.ts` generates a standardized filename:
   ```
   YYYYMMDD_Vendor_Category_Amount.jpg
   ```
3. The image is sent to Apps Script `uploadFile` via base64, saved into Google Drive's `CashFlow_Receipts` folder, and the public Google Drive URL is stored in `receipt_url`.
4. Users can batch-download all receipts for a tax year or date range in a single ZIP file.

### 9.3 PIN Security & Trusted Device Flow

- The app is protected by a 4-digit PIN lock screen (`src/components/auth-provider.tsx`).
- Default PIN: `1214` (configurable via `NEXT_PUBLIC_APP_PIN` or in Settings).
- **"Trust this device"**: When checked, `localStorage.setItem('cashflow_trusted_device', 'true')` is set. On subsequent visits, authentication is automatic without prompting.

### 9.4 AI Expense Parser API

- Route: `/api/ai/parse-expense`
- Users can type or speak natural language phrases (e.g., *"Dinner at Haidilao RM 128 yesterday"* or *"Grab ride 25 myr"*).
- Powered by Gemini 1.5 Flash to automatically extract amount, currency, category, date, and description.

---

## 10. Automated Testing & Quality Assurance

To prevent regressions, the project includes an automated end-to-end browser test script:

```bash
npm run test:e2e
```

### What `scripts/test_ui_flow.js` Tests:
1. Launches Microsoft Edge headlessly via `puppeteer-core`.
2. Seeds `cashflow_trusted_device: 'true'` to bypass the PIN screen.
3. Verifies Home page (`/`) renders without console errors.
4. Navigates to `/transactions`, verifies transaction cards render.
5. Clicks **Record Payment**, checks that the modal opens and closes properly.
6. Clicks an existing transaction row, validates the **Transaction Detail Modal**, clicks **Edit Transaction**, verifies that all form fields pre-fill correctly, and closes the modal.
7. Iterates through all other dashboard routes (`/budget`, `/investments`, `/trips`, `/invoices`, `/analytics`, `/settings`).
8. Fails the build (`exit 1`) if any unhandled error or React runtime crash occurs.

---

## 11. Golden Rules for AI Models & Developers

When prompted to modify or extend this codebase, **every AI model must follow these rules**:

### Rule 0: Strict Scope Policy — Zero-Unsolicited Data Touch (数据绝对安全与禁触准则)
> [!CAUTION]
> **IRONCLAD USER DATA PROTECTION MANDATE**:
> 1. **NEVER TOUCH, INSERT, MODIFY, OR DELETE REAL USER FINANCIAL DATA UNLESS EXPLICITLY INSTRUCTED BY THE USER.**
> 2. **NO UNPROMPTED BACKGROUND WRITES**:
>    - `DEFAULT_COMMITMENTS` must remain an empty array `[]`. Never inject synthetic recurring commitments into the live database.
>    - Installments must never pre-insert future months into transactions.
> 3. **TESTS MUST NEVER MUTATE LIVE PRODUCTION DATA**:
>    - Any automated test or headless script must set `localStorage.setItem('cashflow_test_mode', 'true')` so background auto-recording hooks are completely disabled.
> 4. **CONFIRMATION BEFORE LIVE RUN**:
>    - The AI assistant must never execute ad-hoc scripts that write, mutate, or purge database/sheet rows unless the user explicitly requests and approves that exact operation.

### Rule 1: React Hook Order is Sacred
> [!CAUTION]
> Never place a hook (`useMemo`, `useEffect`, `useState`, `useCallback`) after an early return or condition!  
> Always declare all hooks at the very top of the React component before any conditional returns (`if (!item) return null;`). Violating this causes `Minified React error #310` in production.

### Rule 2: Respect the Installment Month-by-Month Logic
- Never batch-insert future installment months into transactions or Google Sheets.
- Only record the current due month. Let `checkAndAutoRecordInstallments` handle future months as time passes.

### Rule 3: Keep the Installment Dashboard Clean
- Do not add intrusive edit or delete buttons to `installment-dashboard.tsx` cards. The user strictly prefers the clean visual card with progress metrics, with tapping opening the edit modal.

### Rule 4: Always Maintain the Sheets SOT & Cache Contract
- Google Sheets is the permanent Source of Truth.
- Local storage is strictly a limited cache with a rolling 60-day / 3-month window.
- Historical data outside the rolling window must be loaded on demand.
- Settings, recurring rules, installment plans, and pending mutations must NEVER be pruned or expired.

### Rule 5: Prevent UI Scroll Jumping
- When switching between views (e.g. Recent Transactions list vs Monthly Calendar), do not unmount parent containers or trigger window scrolls. Preserve the user's scroll position.

### Rule 6: Pre-Push Verification
- Always execute `npm run build` to verify TypeScript and Next.js compilation before committing.

---

## 12. Troubleshooting & Common Pitfalls

### Issue: "Changes pushed to GitHub do not reflect on Vercel"
- Check the Vercel Deployments dashboard.
- If the build failed, review the build log. Most common reasons:
  - TypeScript typing mismatch.
  - ESLint error.

### Issue: "Transaction added in UI is not showing in Google Sheets"
- In Server Proxy mode, verify `APPS_SCRIPT_URL`, `APPS_SCRIPT_API_KEY`, and `CASHFLOW_PROXY_TOKEN` are configured on the server and that the device token is saved in Settings.
- Verify `API_KEY` in Apps Script Project Settings matches `APPS_SCRIPT_API_KEY`.
- Check the top header sync badge: if offline or queued, check if there are items in the pending queue.
- Click **Sync Now** or test the Apps Script connection in **Settings**.

### Issue: "Older transactions from last year aren't visible offline"
- This is intentional: CashFlow keeps only the recent 60-day active window on the device to prevent mobile browser storage overflow.
- When you select any older month or year in the calendar, CashFlow fetches the data on demand directly from Google Sheets.

---

*Authored for the CashFlow Project. Maintained by weishennn & Antigravity AI.*
