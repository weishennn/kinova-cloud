# 💎 Kinova

A stunning, mobile-first Progressive Web App for personal finance & wealth tracking, powered by Google Sheets as a database and synced with **Trixpense** for group travel.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38B2AC?logo=tailwind-css)

## ✨ Features

- 📊 **Dashboard** — Beautiful overview of your finances with interactive charts
- 💸 **Transactions** — Record income & expenses with dynamic categories
- 📈 **Investment Portfolio** — Track stocks, crypto, unit trusts with P&L calculations
- 🧾 **Invoice Manager** — Upload, tag, and download receipts & invoices
- ✈️ **Trip Tracker** — Track travel spending with multi-currency support & live Trixpense sync
- 🧮 **Tax Calculator** — Malaysia progressive tax with relief estimation
- 📊 **Analytics** — Spending trends, category comparisons, net worth tracking
- 🎯 **Budget Planner** — Set & monitor category budgets with visual progress
- 🔄 **Adaptive Schema** — Auto-detects new columns added to your Google Sheet
- 🌙 **Dark Mode** — OLED-friendly true black theme
- 📱 **PWA** — Install on iPhone or Android home screen for native app feel

---

> 📖 **Looking for the deep technical manual?**  
> Check out the **[Complete Developer & AI Architecture Guide](DEVELOPER_GUIDE.md)** for a file-by-file codebase breakdown, Vercel CI/CD setup, Google Sheets Source of Truth architecture, 60-day rolling cache engine, and rules for AI models modifying this codebase.

---

## 🏗️ Tech Stack

| Layer | Technology |
|:---|:---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Frontend | React 19 + shadcn/ui + Tailwind CSS v4 |
| State & Cache | Zustand v5 + TanStack Query v5 |
| Source of Truth | Google Sheets (multi-month tabs, permanent ledger) |
| Client Storage | LocalStorage (Rolling 60-day cache, offline queue) |
| Script Bridge | Google Apps Script (`apps-script/Code.gs`) |
| Storage | Google Drive (`CashFlow_Receipts` folder) |
| Testing | Puppeteer Core + Microsoft Edge E2E |
| Hosting & CI/CD | Vercel (push-to-deploy via GitHub) |

## 🚀 Getting Started

### Quick Start for Friends

You need Node.js 18 or newer. Clone the project, install its dependencies, and run the setup wizard:

```bash
git clone <repo-url>
cd kinova
npm install
npm run setup
npm run dev
```

The wizard walks you through creating a Google Sheet and Apps Script Web app, then saves your settings to `.env.local`. Press Enter at the Sheet URL prompt to use browser-local storage without Google Sheets. You can skip the Gemini key to leave AI features disabled. `.env.local` is ignored by Git and should not be committed.

To try the wizard without changing an existing `.env.local`, choose another output file:

```bash
npm run setup -- --output .env.test.local
```

### Run and deploy

Run `npm run build` to create a production build. To deploy, import the repository in Vercel and add the environment variables from `.env.example` in Project Settings before deploying. `GEMINI_API_KEY` is used by server routes. The Apps Script key also has a `NEXT_PUBLIC_` setting because direct browser connections need it; values with that prefix are included in browser code.

### Optional Trixpense trip links

Set only `NEXT_PUBLIC_SPLITWISE_APP_URL` to the deployed Trixpense URL in `.env.local` and in Kinova's Vercel settings. Trixpense hosts a read-only API endpoint and uses its own Supabase publishable/anon key, so Kinova needs no separate database key. In Kinova, open a trip, enter the Trixpense 8-character invite code, and choose your member name to automatically sync your personal share into Kinova Flow, Overview, and Trip Budget.

### Manual Apps Script setup

If you prefer to deploy the backend yourself, create a Google Sheet, choose **Extensions → Apps Script**, paste `apps-script/Code.gs`, then deploy as a Web app with **Execute as: Me** and **Who has access: Anyone**. Use the deployment URL ending in `/exec` in the setup wizard. The wizard configures the endpoint key and verifies the bound Sheet connection.

### 6. Add to iPhone

1. Open your deployed URL in Safari
2. Tap the **Share** button (square with arrow)
3. Scroll down → **Add to Home Screen**
4. Tap **Add**

## 📁 Project Structure

```
cashflow/
├── apps-script/          # Google Apps Script backend
│   ├── Code.gs           # API bridge
│   ├── Setup.gs          # Initial setup helper
│   └── appsscript.json   # Manifest
├── public/               # Static assets & PWA manifest
├── src/
│   ├── app/              # Next.js App Router pages
│   │   └── (dashboard)/  # All dashboard pages
│   ├── components/
│   │   ├── ui/           # shadcn/ui components
│   │   └── shared/       # Layout, navigation, FAB
│   ├── hooks/            # TanStack Query data hooks
│   ├── lib/              # API client, utilities, tax engine
│   ├── stores/           # Zustand state management
│   └── types/            # TypeScript type definitions
└── ...config files
```

## 🤝 Contributing

This is a personal project, but feel free to fork it for your own use!

## 📄 License

MIT
