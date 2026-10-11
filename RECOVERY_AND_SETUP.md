# CashFlow Setup, Security, Backup & Recovery Guide

This guide provides the complete operational checklist for deploying the Google Apps Script backend, configuring endpoint access control, verifying automated backups, running dry-run restore tests, resolving cross-device conflicts, and onboarding a new phone safely.

---

## 1. Configuring Google Apps Script (`Code.gs` & `Backups.gs`)

1. Open your Google Sheet and click **Extensions → Apps Script**.
2. Create or update two files in your Apps Script project:
   - **`Code.gs`**: Paste the contents of [`apps-script/Code.gs`](./apps-script/Code.gs).
   - **`Backups.gs`**: Paste the contents of [`apps-script/Backups.gs`](./apps-script/Backups.gs).
3. Click **Deploy → Manage deployments → Edit (pencil icon) → Version: New version → Deploy**.
4. Authorize Google Sheets and Google Drive permissions when prompted.
5. The updated script creates a `Deleted Records` system tab on the next successful data mutation and moves existing deletion markers into it after verifying their IDs. This tab is included in backups; do not delete or rename it.

---

## 2. Setting Endpoint Access Control & Server Proxy (P0 #5)

A public Google Apps Script `/exec` URL is callable by anyone who knows the URL unless an `API_KEY` is enforced in Script Properties. Furthermore, storing a secret key solely in browser `localStorage` allows anyone with access to that device's browser devtools to read it.

### Required Server-Authenticated Setup:
1. **Set the Apps Script key before deploying the updated script**:
   - In Apps Script **Project Settings → Script Properties**, set `API_KEY` to a randomly generated 32-byte secret encoded as hex (64 characters). The updated script fails closed when this property is missing or shorter than 32 characters. For first-time setup, set the property manually; the app cannot securely bootstrap a public endpoint with no existing key.
2. **Configure Next.js server environment variables** (`.env.local` or hosting environment):
   ```env
   APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
   APPS_SCRIPT_API_KEY=your_strong_secret_api_key
   CASHFLOW_PROXY_TOKEN=your_random_32_byte_token_encoded_as_hex
   ```
   Generate each secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. `APPS_SCRIPT_API_KEY` must match Apps Script's `API_KEY`. Keep these values server-only; do not use `NEXT_PUBLIC_` names. The endpoint URL must be a Google Apps Script `/exec` URL.
3. **Configure each device**:
   - In CashFlow **Settings → Google Drive & Sheets Connection**, keep **Server Proxy Mode (`/api/sheets`)** enabled and paste the same `CASHFLOW_PROXY_TOKEN` into **Server Proxy Access Token**. The token is stored in that device's browser storage; only trusted devices should receive it.
   - The proxy rejects requests if server credentials are missing and never accepts a destination URL or Apps Script key from the browser.

---

## 3. Installing & Verifying Weekly Backups + Independent Offline Backups (P2 #13, #14)

### Automated Google Drive Snapshots:
1. Open **Settings → Google Drive Automated Backups**.
2. Click **Enable Weekly Backup** (or **Verify Weekly Trigger**).
3. Confirm the badge shows **Weekly Trigger Active** and **Backup Health: Healthy**.
4. **Retention Policy**:
   - Scheduled weekly backups run every Sunday at 03:00 (`installCashFlowWeeklyBackup`).
   - Up to **12 weekly backups** and **10 pre-migration/safety snapshots** are retained in the `CashFlow Backups` Drive folder. Old snapshots are pruned only after at least 2 verified healthy backups exist.
   - If the latest backup is older than 8 days or fails deep tab/header verification, Settings displays a **Stale / Unverified Backup Alert**.

### Independent Offline Backup (Outside Google Drive):
1. In **Settings → Independent Offline Backup & Integrity**, click **Export Offline Backup (.json)**.
2. Store the dated `.json` file on your phone/computer or secondary cloud storage (iCloud, OneDrive, local disk) so you have a complete recovery copy independent of your Google account.

---

## 4. Running a Safe Dry-Run Test Restore & Live Staged Restore (P0 #2, #3, P2 #15)

### Dry-Run Test Restore (Zero Risk to Live Sheet):
1. In **Settings → Available Google Drive Snapshots**, click **Test Restore (Dry Run)** next to any snapshot.
2. The server creates a temporary isolated test spreadsheet, copies all tabs from the backup, verifies tab names, headers, record IDs, row counts, and `Overview` formulas, deletes the temporary test spreadsheet, and displays a detailed pass/fail verification report without touching your live Sheet.

### Live Staged Restore with Automatic Rollback:
1. Click **Restore Snapshot** next to the desired backup.
2. Confirm the restore. If local pending edits exist, the confirmation states that they will be discarded so stale phone queues cannot overwrite the selected backup. Export an independent backup first if you need to preserve those pending edits.
3. The server:
   - Creates and deep-verifies a `Pre-Restore Safety` snapshot of your current Sheet first.
   - Copies all backup tabs into temporary `__STAGE_` tabs and validates headers and row counts.
   - If any validation fails, deletes all `__STAGE_` tabs and leaves your live Sheet untouched.
   - Swaps the verified tabs into place while retaining the old tabs until final row-count, header, stable-ID, and Overview formula checks pass. If a check fails, it removes the staged tabs and attempts to restore the original tab names. It deletes old tabs only after verification succeeds.
4. Your device reconciles its local cache and outboxes and displays a summary of restored tabs, rows, and discarded/retained local changes.

---

## 5. Onboarding a New Phone Safely (P0 #4, P1 #8–#12)

1. Open CashFlow on the new phone and unlock with your Master PIN.
2. Go to **Settings**, enter your Web App URL (or use Server Proxy mode), and click **Save Credentials**.
3. CashFlow automatically:
   - Verifies that a confirmed pre-migration Drive snapshot exists before running any plan migration.
   - Downloads your active **Recurring Commitments**, **Installment Plans**, **Category Caps**, and **Currency** from Google Sheets (`cashflow_sync_v2_*` envelopes). Deleted plan and transaction IDs remain on the authoritative Sheet as persistent tombstones so a device returning years later cannot resurrect them.
   - Validates plan counts and IDs before marking device onboarding complete.
4. If the phone had any pre-existing local plans that differed from the Sheet, a **Device Plan Recovery** card appears in Settings so you can inspect and merge or dismiss them without losing a single record.
