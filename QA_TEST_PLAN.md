# CashFlow Bookkeeping & Cashflow App — QA Test Plan

**Document status:** Execution-ready draft; actual results are intentionally blank.  
**Application reviewed:** `cashflow` Next.js app in this workspace.  
**Test baseline:** Native CashFlow features only. No Splitwise/Trixpense account, invite code, service, API, or data is required.

## 1. Scope and assumptions

### In scope (confirmed in current code)

- PIN unlock, changing the 4-digit PIN, and trusted-device preference. There is no native user registration/profile/account-management workflow identified.
- Income and expense entry, edit and delete; date, amount, currency, category, description, payment method/account label, notes, and trip tag fields.
- Transaction lists, month selection, type filtering, text search, descending date order, and analytics/budget month views.
- Dashboard/analytics income, expense, net, category, trend, and related summaries. Base-currency summaries use MYR and configured/stored exchange rates.
- Trip create/edit/delete; name, destination, dates, budget, currency, exchange rate and expenses linked by trip name/ID. Trip expense totals and budget progress are native features.
- Overall/category budget settings; recurring commitment tracking/auto-record; installment plans and month-by-month installment recording.
- Google Sheets synchronization when configured, browser-local mode, local cache, pending offline mutations, and refresh/reload persistence.

### Excluded or not established as native requirements

- External group expense services and trip participants/member balances. Those are optional linked-panel behavior and are not a prerequisite for this plan.
- Multiple owned financial accounts with separately maintained balances, inter-account transfers, reconciliation, or transfer fees. The transaction `account` field is a payment-method label, not evidence of account ledgers.
- A user profile with identity/contact details, password reset, or multi-user permissions.
- Goals as a first-class record/workflow. Settings include savings-related values, but a goal lifecycle and success criteria are not confirmed.
- Native recurring transaction schedules beyond the commitment and installment behavior described below.
- Exact decimal rounding policy for input with more than two fractional digits, historical FX rate source/locking rules, and treatment of transactions whose currency/rate is unknown.

### Execution safety and setup assumptions

1. Execute only against a dedicated disposable browser profile and isolated test sheet/local-only configuration. Do not use the user's live ledger or production sheet.
2. Before any browser automation, set `localStorage.cashflow_test_mode = 'true'`; this disables automatic recurring/installment writes during test setup. For tests explicitly validating auto-record behavior, use a disposable test environment and control the clock/data there.
3. Seed transactions through the UI or a clearly isolated fixture. Verify persistence by reading the app's displayed ledger after refresh and, for cloud mode, by checking the isolated test sheet independently.
4. For normal numeric checks below, amounts use MYR unless noted. Display is formatted to two decimal places. Where FX defaults are used, current code's fallback table specifies USD 1 = MYR 4.10, SGD 1 = MYR 3.20, and JPY 1 = MYR 0.028. Production live rates can differ; inject/record the rate used in the test environment.
5. Values used for assertions are intentionally cent-exact. Precision beyond two decimal places and rounding tie behavior require a product decision before asserting a universal result.

## 2. Feature coverage matrix

| Area | Coverage | Status / boundary |
|---|---|---|
| PIN and device access | Unlock, invalid PIN, PIN update, trusted device | Confirmed; convenience PIN lock, not full identity/authentication system |
| Profile management | Personal identity/profile fields | Not found; settings-only scope applies |
| Income/expense CRUD | Create, edit, delete, categories, details | Confirmed |
| Currency/date/amount | Supported currencies, date boundaries, amount precision | Confirmed fields; precision/FX policy needs clarification |
| Cash balance/cashflow | Income minus expense and displayed analytics | Summary/net is present; separately tracked account balances are not confirmed |
| Transfers | Inter-account transfer records | Not found; out of scope pending confirmation |
| Budget | Monthly total and category caps/progress | Confirmed |
| Goals | Goal create/track/complete | Not confirmed; out of scope pending confirmation |
| Recurring | Commitment tracker and optional auto-record | Confirmed; test-mode guard and idempotence are important |
| Installments | Plan schedule, one due installment at a time | Confirmed; no future-month prefill expected |
| Trips | CRUD, budget, currency/rate, native tagged expenses and summaries | Confirmed |
| Trip participants | Native participant/member management | Not found; optional external linking excluded |
| Search/filter/sort | Search, month, type and descending date | Confirmed; category/date range beyond available UI must be verified before claiming support |
| Persistence/history | Local cache, Sheets SOT when configured, offline queue | Confirmed architecture; independently verify UI and source persistence |
| External integration | Splitwise/Trixpense | Excluded from baseline; no dependency for any expected result |

## 3. Test data

Use unique descriptions prefixed `QA-YYYYMMDD-<case>` to find test records. Suggested baseline for a selected month:

| ID | Date | Type | Category | Description | Amount | Currency | Tag |
|---|---|---|---|---|---:|---|---|
| QA-I1 | 2026-10-01 | Income | Salary | QA salary | 5,000.00 | MYR | — |
| QA-E1 | 2026-10-02 | Expense | Food & Dining | QA lunch | 25.50 | MYR | — |
| QA-E2 | 2026-10-03 | Expense | Transport | QA train | 10.00 | MYR | — |
| QA-E3 | 2026-10-04 | Expense | Travel | QA trip meal | 100.00 | CNY | QA trip name |
| QA-E4 | 2026-10-31 | Expense | Utilities | QA month end | 50.00 | MYR | — |

For this fixture, MYR-native income is **5,000.00**, MYR-native expenses **85.50**, net across all transactions at the fallback CNY rate is **5,000.00 − (85.50 + 100.00 × 0.60) = MYR 4,854.50**. Currency totals must retain the original currency on transaction detail; summary values must use MYR exactly once.

## 4. Detailed test cases

For each case, record screenshots/video plus the independent persistence evidence specified. Leave Actual Result and Status blank until execution. `Pass/Fail/Blocked` is the recommended status vocabulary.

### Access, settings, and account scope

#### QA-ACC-01 — Unlock with configured PIN
- **Feature / Module:** Access / PIN
- **Test Scenario:** Valid PIN unlocks the app.
- **Preconditions:** Isolated browser; trusted-device flag absent; configured PIN known.
- **Test Data:** Correct configured four-digit PIN.
- **Numbered Test Steps:** 1. Open the app. 2. Enter the configured PIN. 3. Submit. 4. Navigate to Transactions.
- **Expected Result:** Protected app content is accessible and the transaction route renders without a second prompt in the same session.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Positive / Security
- **Evidence Required:** Redacted screenshot of unlocked route; browser storage state with PIN value omitted.

#### QA-ACC-02 — Reject incorrect PIN without unlocking
- **Feature / Module:** Access / PIN
- **Test Scenario:** Incorrect PIN is rejected.
- **Preconditions:** Isolated browser locked; correct PIN known.
- **Test Data:** An incorrect four-digit value.
- **Numbered Test Steps:** 1. Open the app. 2. Enter the incorrect PIN. 3. Submit. 4. Attempt to access a dashboard route.
- **Expected Result:** Error feedback is shown; protected content remains inaccessible; no financial data changes.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Negative / Security
- **Evidence Required:** Screenshot of error and locked state; before/after transaction count.

#### QA-ACC-03 — Validate PIN format and save a new PIN
- **Feature / Module:** Settings / PIN
- **Test Scenario:** PIN accepts exactly four digits and rejects invalid length/characters.
- **Preconditions:** Unlocked test profile; Settings route available.
- **Test Data:** `123` (short), `12345` (long), `12a4` (non-digit), `2468` (valid).
- **Numbered Test Steps:** 1. Try each invalid value in the PIN update flow. 2. Save each. 3. Enter `2468` and save. 4. Reload and unlock with `2468`.
- **Expected Result:** Invalid values do not replace the saved PIN; valid four-digit PIN saves and works after reload. No transaction rows change.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Validation / Persistence
- **Evidence Required:** Validation feedback; successful post-reload unlock; redacted settings state.

#### QA-ACC-04 — Trusted-device preference persists and can be revoked
- **Feature / Module:** Access / Device trust
- **Test Scenario:** Trust choice suppresses the next PIN prompt; revocation restores it.
- **Preconditions:** Isolated browser and known PIN.
- **Test Data:** Trusted-device checkbox on, then revoked.
- **Numbered Test Steps:** 1. Unlock and enable trust. 2. Close/reopen the app in the same browser profile. 3. Confirm access behavior. 4. Revoke trust in Settings. 5. Reopen.
- **Expected Result:** Trust persists only in that browser profile; after revocation, next visit requires PIN. No cross-profile trust is assumed.
- **Actual Result:**
- **Status:**
- **Priority:** Medium
- **Test Type:** Positive / Persistence / Security
- **Evidence Required:** Redacted storage flag and screenshots before/after revocation.

#### QA-ACC-05 — Confirm unsupported native profile and account-ledger scope
- **Feature / Module:** Account / Profile scope
- **Test Scenario:** Verify there is no implied identity profile, multi-account balance, or transfer record feature.
- **Preconditions:** App routes loaded; no external integration configured.
- **Test Data:** None.
- **Numbered Test Steps:** 1. Inspect navigation and Settings. 2. Inspect transaction entry fields. 3. Check for a native account list, account balance, transfer type, or profile identity form.
- **Expected Result:** Record only present PIN/device/preferences and payment-method labels. Mark native profile, account balances, and transfers as not implemented/requirements unclear; do not report their absence as a functional failure unless product requirements confirm them.
- **Actual Result:**
- **Status:**
- **Priority:** Medium
- **Test Type:** Scope / Exploratory
- **Evidence Required:** Route screenshots and field inventory.

### Transactions and data validation

#### QA-TXN-01 — Create an income transaction
- **Feature / Module:** Transactions / Income
- **Test Scenario:** Save a valid income row.
- **Preconditions:** Isolated test ledger; Transactions route open.
- **Test Data:** 2026-10-01, Salary, `QA salary`, MYR 5,000.00, payment method `Bank`, notes `income fixture`.
- **Numbered Test Steps:** 1. Open add transaction. 2. Select Income. 3. Enter all test data. 4. Save. 5. Confirm one matching row in UI. 6. Reload and independently inspect test source.
- **Expected Result:** Exactly one row exists with matching type/date/category/description/currency/amount; income summary increases by MYR 5,000.00 exactly once after persistence.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Positive / Data integrity
- **Evidence Required:** Saved row before/after reload; isolated source row/ID; summary screenshot.

#### QA-TXN-02 — Create a categorized expense with optional fields
- **Feature / Module:** Transactions / Expense
- **Test Scenario:** Save an expense and retain category, account label, notes and date.
- **Preconditions:** Isolated test ledger.
- **Test Data:** 2026-10-02, Food & Dining, `QA lunch`, MYR 25.50, payment method `Cash`, notes `lunch fixture`.
- **Numbered Test Steps:** 1. Open add transaction. 2. Select Expense. 3. Enter data. 4. Save. 5. Reopen details. 6. Reload and verify source.
- **Expected Result:** One expense is saved; displayed amount is RM 25.50; category and optional fields remain unchanged; total expense increases by MYR 25.50.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Positive / Data integrity
- **Evidence Required:** Detail view, summary delta, persisted source row.

#### QA-TXN-03 — Reject missing required fields and invalid amount
- **Feature / Module:** Transactions / Validation
- **Test Scenario:** Required fields and amount constraints prevent invalid ledger rows.
- **Preconditions:** Isolated test ledger; capture initial row count and summaries.
- **Test Data:** Blank amount, zero, negative amount, blank date, and blank category/description as applicable to visible form requirements.
- **Numbered Test Steps:** 1. Submit each invalid combination. 2. Observe inline/browser validation. 3. Reload. 4. Compare row count and summaries.
- **Expected Result:** Invalid entries are not persisted; row count and totals remain unchanged; the user receives actionable validation feedback. If zero/negative policy is not explicit, log actual behavior as a requirement question rather than assuming policy.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Negative / Validation
- **Evidence Required:** Invalid form states, row-count and total comparison, isolated source check.

#### QA-TXN-04 — Edit amount, category and date and propagate everywhere
- **Feature / Module:** Transactions / Edit
- **Test Scenario:** Edit a saved expense and verify ledger, totals, analytics and budget update.
- **Preconditions:** QA-TXN-02 saved; month selected.
- **Test Data:** Change MYR 25.50 to MYR 40.00; category Food & Dining to Utilities; date to 2026-10-05.
- **Numbered Test Steps:** 1. Open transaction detail. 2. Edit fields. 3. Save. 4. Verify list and monthly totals. 5. Verify affected category and budget views. 6. Reload and inspect source row.
- **Expected Result:** Same transaction identity is updated once; October expense rises by net MYR 14.50; category totals move MYR 25.50 out of Food & Dining and MYR 40.00 into Utilities; no stale copy remains on old date/category.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Positive / Regression / Data integrity
- **Evidence Required:** Before/after detail, summaries, category/budget views, persisted row/ID.

#### QA-TXN-05 — Delete a transaction and remove its impact everywhere
- **Feature / Module:** Transactions / Delete
- **Test Scenario:** Confirmed deletion removes the row and reverses all derived totals.
- **Preconditions:** QA-TXN-04 saved; isolated source; baseline captured.
- **Test Data:** Edited MYR 40.00 expense.
- **Numbered Test Steps:** 1. Choose delete. 2. Cancel once and verify no change. 3. Choose delete again and confirm. 4. Verify list, total, analytics, category and budget. 5. Reload and inspect source.
- **Expected Result:** Cancel leaves the transaction unchanged. Confirmed delete removes exactly one row; expense decreases MYR 40.00 and corresponding category/budget totals recalculate; deleted row does not return after reload.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Negative / Positive / Regression / Data integrity
- **Evidence Required:** Confirmation/cancel screenshots, post-delete summaries, source row absence/tombstone status.

#### QA-TXN-06 — Prevent duplicate submission on repeated save
- **Feature / Module:** Transactions / Duplicate prevention
- **Test Scenario:** Rapid repeated submission or retry does not create duplicate entries.
- **Preconditions:** Isolated ledger; network throttling available or save button can be double-clicked.
- **Test Data:** Unique expense `QA duplicate`, MYR 12.34.
- **Numbered Test Steps:** 1. Enter valid expense. 2. Double-click Save or retry after delayed response. 3. Reload. 4. Search exact description and inspect source IDs.
- **Expected Result:** Exactly one persisted row and one MYR 12.34 contribution. If duplicate rows occur, log as high-severity data-integrity defect.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Negative / Concurrency / Data integrity
- **Evidence Required:** Search results, row count, source IDs and network timeline.

#### QA-TXN-07 — Month end, year end, leap day and timezone date handling
- **Feature / Module:** Transactions / Date handling
- **Test Scenario:** Dates remain on the selected calendar day and in the correct reporting period.
- **Preconditions:** Isolated browser with test clock/timezone noted.
- **Test Data:** 2024-02-29, 2026-10-31, 2026-12-31, 2027-01-01.
- **Numbered Test Steps:** 1. Create one test transaction per date. 2. Verify displayed dates. 3. Select each month/year. 4. Reload and verify date values.
- **Expected Result:** Each date is preserved exactly as entered; month/year views include it once in its calendar period; no UTC conversion shifts it to an adjacent day/month.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Boundary / Regression
- **Evidence Required:** Detail dates, month list and per-month search results, persisted dates.

#### QA-TXN-08 — Amount decimal precision and formatting boundary
- **Feature / Module:** Transactions / Amount precision
- **Test Scenario:** Validate accepted precision and consistent displayed/stored value.
- **Preconditions:** Isolated test ledger; product-approved precision rule documented if available.
- **Test Data:** `0.01`, `1.10`, `123456.78`, `1.005`, `1.999`, blank, and a value above supported range if UI defines one.
- **Numbered Test Steps:** 1. Enter each amount. 2. Save where accepted. 3. Inspect detail, summaries, and source value. 4. Reload and compare.
- **Expected Result:** Cent-exact values retain their exact value and display to 2 decimal places. For >2 decimal input, record whether input is rejected or rounded; compare against approved rule. No silent discrepancy between source, detail, and report. Tie-breaking/rounding policy is currently unspecified and requires product confirmation.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Boundary / Validation / Calculation
- **Evidence Required:** Input and detail screenshots; raw stored value; summary before/after.

#### QA-TXN-09 — Currency selection and native amount preservation
- **Feature / Module:** Transactions / Multi-currency
- **Test Scenario:** Foreign-currency expense retains native amount and converts once in MYR summaries.
- **Preconditions:** Isolated test ledger; known test FX rates.
- **Test Data:** USD 10.00 with USD→MYR 4.10; SGD 10.00 with SGD→MYR 3.20; JPY 100 with JPY→MYR 0.028.
- **Numbered Test Steps:** 1. Create each expense. 2. Verify transaction detail currency and amount. 3. Verify MYR analytics totals. 4. Reload and repeat.
- **Expected Result:** Details show USD 10.00, SGD 10.00, JPY 100. Summary conversion deltas are respectively MYR 41.00, MYR 32.00 and MYR 2.80; no foreign amount is treated as MYR and no double conversion occurs.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Positive / Calculation / Regression
- **Evidence Required:** Detail screens, configured/stored FX rate, report totals and persisted base amount/rate if present.

#### QA-TXN-10 — Custom category and category integrity
- **Feature / Module:** Transactions / Categories
- **Test Scenario:** Verify a chosen/custom category persists and consistently groups transactions.
- **Preconditions:** Isolated test ledger; category creation or selection capability available in current UI.
- **Test Data:** Category `QA Pet Care`; expense MYR 18.75.
- **Numbered Test Steps:** 1. Create/select the category. 2. Save the expense. 3. Verify transaction detail, category analytics and budget category view. 4. Reload.
- **Expected Result:** If custom categories are supported, category name persists exactly and its MYR 18.75 appears once in relevant breakdowns. If UI only offers fixed categories, mark custom-category creation unsupported rather than inventing expected behavior.
- **Actual Result:**
- **Status:**
- **Priority:** Medium
- **Test Type:** Positive / Persistence / Scope
- **Evidence Required:** Category selector and detail, breakdown, post-reload view.

### Cashflow, reports, filtering, and budgets

#### QA-FIN-01 — Validate income, expense and net calculations
- **Feature / Module:** Dashboard / Cashflow summary
- **Test Scenario:** Summary includes only applicable income/expense and calculates net.
- **Preconditions:** QA baseline fixture loaded in isolated month.
- **Test Data:** Fixture in Section 3.
- **Numbered Test Steps:** 1. Open dashboard/summary for October 2026. 2. Compare income, expense and net to independently calculated control values. 3. Reopen after reload.
- **Expected Result:** Income = MYR 5,000.00; expenses = MYR 145.50 including CNY 100 × 0.60; net = MYR 4,854.50. Investment rows (if present) are not silently counted as expense unless explicitly specified.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Calculation / Regression
- **Evidence Required:** Report screenshot, fixture rows and calculation worksheet.

#### QA-FIN-02 — Income-versus-expense date-range boundaries
- **Feature / Module:** Analytics / Date range
- **Test Scenario:** Verify inclusive start/end boundaries and adjacent dates in supported period controls.
- **Preconditions:** Isolated rows on 2026-10-01, 2026-10-31 and 2026-11-01.
- **Test Data:** MYR 10 income on start; MYR 20 expense on end; MYR 30 expense next day.
- **Numbered Test Steps:** 1. Select October 2026 using available reporting controls. 2. Compare totals. 3. Select November. 4. Compare totals.
- **Expected Result:** October includes start/end rows and excludes Nov 1: income MYR 10, expense MYR 20. November includes only Nov 1 expense MYR 30. If only month selection exists, execute month boundary equivalent and note custom date-range reporting is not confirmed.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Boundary / Calculation
- **Evidence Required:** Selected period and displayed totals; source dates.

#### QA-FIN-03 — Category breakdown percentages and rounding
- **Feature / Module:** Analytics / Category report
- **Test Scenario:** Category amounts and percentages reconcile to total expenses.
- **Preconditions:** Isolated report period with two expense categories.
- **Test Data:** Food MYR 25.00; Transport MYR 75.00.
- **Numbered Test Steps:** 1. Open category report. 2. Verify amounts and percentages. 3. Sum category amounts and percentages.
- **Expected Result:** Food = MYR 25.00 / 25%; Transport = MYR 75.00 / 75%; category amount sum = MYR 100.00; percentage sum = 100% (within display rounding if more categories are used).
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Calculation
- **Evidence Required:** Category report screenshot and independent sum.

#### QA-FIN-04 — Budget progress at, below and above cap
- **Feature / Module:** Budget
- **Test Scenario:** Overall budget progress and remaining/over amount are mathematically consistent.
- **Preconditions:** Test month isolated; monthly budget can be set.
- **Test Data:** Budget MYR 1,000; expenses MYR 999.99, MYR 1,000.00, then MYR 1,000.01.
- **Numbered Test Steps:** 1. Set budget to MYR 1,000. 2. Seed each spend amount in separate runs or controlled edits. 3. Verify progress and remaining/over display.
- **Expected Result:** At 999.99: remaining MYR 0.01. At 1,000.00: 100.00%, remaining MYR 0.00. At 1,000.01: over budget by MYR 0.01. Reported percentages match spend ÷ 1,000 × 100, subject only to display rounding.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Boundary / Calculation
- **Evidence Required:** Budget configuration and each progress/remaining display.

#### QA-FIN-05 — Category cap edit and removal/update behavior
- **Feature / Module:** Budget / Category cap
- **Test Scenario:** Save category cap and ensure spend progress recalculates.
- **Preconditions:** Known category expense total MYR 120.00.
- **Test Data:** Food cap MYR 200, then MYR 100.
- **Numbered Test Steps:** 1. Set Food cap to 200 and verify 60% use. 2. Change cap to 100. 3. Verify 120% use/overage MYR 20.00. 4. Reload.
- **Expected Result:** Cap persists; percentage and overage use the saved cap and category spend; no other category's progress changes.
- **Actual Result:**
- **Status:**
- **Priority:** Medium
- **Test Type:** Positive / Calculation / Persistence
- **Evidence Required:** Cap value, category spend and recalculated progress before/after reload.

#### QA-FIN-06 — Search, type filter, month filter and sort order
- **Feature / Module:** Transactions / Search and filters
- **Test Scenario:** Combined filters return only matching rows in descending date order.
- **Preconditions:** Seed three rows with distinct date/type/description across October and November.
- **Test Data:** `QA coffee` expense Oct 2; `QA salary` income Oct 3; `QA coffee` expense Nov 1.
- **Numbered Test Steps:** 1. Search `QA coffee`. 2. Apply Expense filter. 3. Select October. 4. Clear each filter and verify results. 5. Check ordering.
- **Expected Result:** Combined result is only Oct 2 coffee expense; search matches description/category case-insensitively if implementation supports; default list order is newest date first. Clearing filters restores all matching rows exactly once.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Positive / Regression
- **Evidence Required:** Screenshots for each filter state and ordered dates.

#### QA-FIN-07 — Empty results and malformed search input
- **Feature / Module:** Transactions / Search
- **Test Scenario:** No-match and punctuation/Unicode queries do not crash or leak unrelated entries.
- **Preconditions:** Test transactions present.
- **Test Data:** Search `QA-no-such-item-!@#` and a Unicode term.
- **Numbered Test Steps:** 1. Enter each query. 2. Confirm empty-state behavior. 3. Clear query and verify original list returns.
- **Expected Result:** No-match state is clear; app remains responsive; no rows are mutated; clearing search restores normal results.
- **Actual Result:**
- **Status:**
- **Priority:** Low
- **Test Type:** Negative / Usability / Regression
- **Evidence Required:** Empty-state screenshot and restored list.

#### QA-FIN-08 — Verify no unsupported account transfer behavior is assumed
- **Feature / Module:** Cash balances / Transfers
- **Test Scenario:** Determine whether an inter-account transfer feature exists in current UI.
- **Preconditions:** No external service configured.
- **Test Data:** None.
- **Numbered Test Steps:** 1. Inspect transaction type options and account/payment fields. 2. Inspect dashboard for per-account balances. 3. Record available behavior only.
- **Expected Result:** If no transfer type or account ledger exists, mark transfer cases not applicable and raise missing requirement; do not simulate a transfer as an expense plus income.
- **Actual Result:**
- **Status:**
- **Priority:** Medium
- **Test Type:** Scope / Exploratory
- **Evidence Required:** Transaction type selector and dashboard screenshots.

### Recurring commitments and installments

#### QA-REC-01 — Commitment settings persist without surprise rows
- **Feature / Module:** Budget / Recurring commitments
- **Test Scenario:** Configure a commitment and ensure creation alone does not unexpectedly book a payment before due date.
- **Preconditions:** Isolated test profile; `cashflow_test_mode=true`; controlled date before due day.
- **Test Data:** QA commitment MYR 80 due on day 28, auto-record enabled.
- **Numbered Test Steps:** 1. Save commitment. 2. Reload. 3. Verify settings persist. 4. Check transaction ledger and row count.
- **Expected Result:** Commitment settings persist; in test mode no automatic transaction is created; no future-period rows appear.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Positive / Persistence / Safety
- **Evidence Required:** Commitment setting (redacted identifiers if any), transaction count, test-mode flag.

#### QA-REC-02 — Recurring auto-record once on/after due date
- **Feature / Module:** Recurring commitments
- **Test Scenario:** Due commitment is recorded at most once for its due month.
- **Preconditions:** Disposable test sheet/profile; auto-record explicitly enabled; controlled clock on due date; test mode disabled only in this isolated environment.
- **Test Data:** One commitment MYR 80 due day 28; run once on 28th and reload/run again same month.
- **Numbered Test Steps:** 1. On due date, load app. 2. Verify row. 3. Reload twice. 4. Search for commitment ID/month.
- **Expected Result:** Exactly one expense row of MYR 80 with the due date/current month; repeated startup creates no duplicate; summary increases once.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Positive / Idempotence / Calculation
- **Evidence Required:** Controlled clock, persisted row ID/date/amount, row count and summary delta.

#### QA-REC-03 — Commitment due-day clamp and inactive/zero amount
- **Feature / Module:** Recurring commitments / Date boundary
- **Test Scenario:** Month-end due day clamps correctly and non-positive/disabled items do not auto-record.
- **Preconditions:** Disposable test environment with controlled clock; auto-record behavior explicitly enabled.
- **Test Data:** Due day 31 in February; one disabled commitment; one zero-amount commitment.
- **Numbered Test Steps:** 1. Run on final day of February. 2. Verify due-date row. 3. Check disabled/zero commitments. 4. Reload.
- **Expected Result:** Due-day 31 clamps to the month's last calendar day; disabled and non-positive items produce zero rows; reload produces no duplicates.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Boundary / Negative / Idempotence
- **Evidence Required:** Controlled date, commitment config and source rows.

#### QA-INS-01 — Installment schedule totals and final-payment adjustment
- **Feature / Module:** Installments / Calculation
- **Test Scenario:** Flat-rate schedule sums to total payable with final cent adjustment.
- **Preconditions:** Isolated test profile; plan creation available.
- **Test Data:** Principal MYR 1,000.00; 0% interest; 3 months; start 2026-10-01.
- **Numbered Test Steps:** 1. Preview/create plan. 2. Independently calculate schedule. 3. Sum installment amounts and compare total payable.
- **Expected Result:** Total interest MYR 0.00; payable MYR 1,000.00; monthly rounded amounts 333.33, 333.33, 333.34; sum exactly MYR 1,000.00. Flat-rate method is the current implementation's stated calculation.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Calculation / Boundary
- **Evidence Required:** Plan preview, individual schedule values and independent sum.

#### QA-INS-02 — Do not prefill future installments; record only when due
- **Feature / Module:** Installments / Persistence
- **Test Scenario:** Future installment months are not inserted early.
- **Preconditions:** Disposable isolated data; test mode enabled during setup; future start date.
- **Test Data:** 3-month plan starting 2026-12-15; principal MYR 300.00, 0% interest.
- **Numbered Test Steps:** 1. Save plan before 2026-12-15. 2. Inspect transaction months. 3. Verify no future transactions exist. 4. In a controlled disposable run on due date, verify only that month records. 5. Reload for duplicate check.
- **Expected Result:** Before due date, zero transaction rows. On first due date, only installment 1 is recorded; no months 2 or 3 are prefilled. Each later due date adds one row once.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Regression / Safety / Persistence
- **Evidence Required:** Plan settings, month-by-month source row counts and IDs.

#### QA-INS-03 — Installment limits and invalid inputs
- **Feature / Module:** Installments / Validation
- **Test Scenario:** Tenure normalization and invalid principal/rate handling.
- **Preconditions:** Isolated plan form.
- **Test Data:** Tenure 0, 1, 120, 121; negative principal; negative interest rate; high decimal principal.
- **Numbered Test Steps:** 1. Submit each boundary case. 2. Inspect resulting tenure and amounts. 3. Confirm no unexpected rows.
- **Expected Result:** Supported tenure is clamped/validated to 1–120 months per implementation; invalid negative principal/rate behavior must match approved rule and must not create negative expenses; record any silent coercion as requirement/defect for product decision. No future rows are preinserted.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Boundary / Validation
- **Evidence Required:** Form feedback, saved plan values, transaction row count.

### Trips (native, independent of external sharing)

#### QA-TRP-01 — Create native trip with budget and dates
- **Feature / Module:** Trips / Create
- **Test Scenario:** Save a trip without an external invite code.
- **Preconditions:** Isolated test ledger; no external integration configured.
- **Test Data:** `QA Kyoto 2026`, destination Kyoto, 2026-10-10 to 2026-10-15, budget JPY 50,000, rate 0.028 MYR/JPY.
- **Numbered Test Steps:** 1. Open Trips. 2. Create trip leaving invite code empty. 3. Save. 4. Reload. 5. Verify list and source Trips row.
- **Expected Result:** Exactly one native trip persists with matching fields; it is usable without external app availability; initial spend MYR/JPY equivalent is zero and remaining budget JPY 50,000.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Positive / Persistence / Independence
- **Evidence Required:** Trip detail/list, source Trips row and empty external-connection state.

#### QA-TRP-02 — Reject invalid trip dates, budget and required name
- **Feature / Module:** Trips / Validation
- **Test Scenario:** Invalid trip data cannot silently create an unusable trip.
- **Preconditions:** Isolated test ledger.
- **Test Data:** Blank name, end date before start date, negative budget, zero budget, nonnumeric budget if accepted by control.
- **Numbered Test Steps:** 1. Attempt each invalid form. 2. Submit. 3. Verify error behavior and Trips row count.
- **Expected Result:** Blank required name and malformed dates are rejected. Negative/zero budget policy is not explicitly documented; no invalid row should be silently accepted without clear UI behavior. Record requirement uncertainty where applicable.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Negative / Validation / Boundary
- **Evidence Required:** Form feedback and before/after trip row count.

#### QA-TRP-03 — Tag native expense and verify trip totals/budget
- **Feature / Module:** Trips / Expenses and summary
- **Test Scenario:** Personal transaction tagged to trip contributes once to trip summary.
- **Preconditions:** QA-TRP-01 trip exists; trip's original currency JPY and rate known.
- **Test Data:** Trip-tagged JPY 1,000 expense; untagged MYR 20 expense.
- **Numbered Test Steps:** 1. Create both expenses. 2. Open trip details. 3. Verify trip spend, remaining budget and currency summary. 4. Inspect main summary.
- **Expected Result:** Trip spend includes only tagged JPY 1,000, shown as JPY 1,000 and MYR 28 at the specified rate; remaining JPY budget = 49,000. Untagged MYR 20 does not affect trip totals. Main expense summary counts each transaction once.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Positive / Calculation / Data integrity
- **Evidence Required:** Transaction details, trip summary, main summary, persisted trip tag.

#### QA-TRP-04 — Multi-currency trip expense conversion
- **Feature / Module:** Trips / Currency conversion
- **Test Scenario:** Foreign transaction converts to trip currency and MYR base consistently.
- **Preconditions:** Trip currency JPY; rate 0.028 MYR per JPY; USD fallback 4.10 MYR/USD.
- **Test Data:** Tagged USD 10 expense.
- **Numbered Test Steps:** 1. Create USD expense tagged to trip. 2. Verify trip-currency total. 3. Verify MYR base summary. 4. Reload and compare.
- **Expected Result:** MYR equivalent = USD 10 × 4.10 = MYR 41.00; JPY trip equivalent = 41 ÷ 0.028 = JPY 1,464.285714…; display to 2 decimals as JPY 1,464.29 if standard display rounding applies. No unexplained use of raw USD 10 as JPY or MYR.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Calculation / Regression
- **Evidence Required:** FX inputs/rates and trip/main summary screenshots.

#### QA-TRP-05 — Edit trip details and preserve linked expenses
- **Feature / Module:** Trips / Edit
- **Test Scenario:** Editing trip metadata does not orphan or duplicate personal expense links.
- **Preconditions:** Trip with at least one tagged transaction.
- **Test Data:** Rename `QA Kyoto 2026` to `QA Kyoto Revised`; update dates/budget.
- **Numbered Test Steps:** 1. Edit trip. 2. Save. 3. Verify trip record. 4. Verify tagged expenses and summary. 5. Reload and inspect IDs/tags.
- **Expected Result:** Trip metadata updates once; existing tagged expense remains associated through stable trip ID or intentional tag migration; no duplicate transaction or unexplained zeroed total. If association is name-based and rename orphans rows, log defect and clarify intended key behavior.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Positive / Regression / Data integrity
- **Evidence Required:** Before/after trip and transaction IDs/tags, totals.

#### QA-TRP-06 — Delete trip and verify expense retention policy
- **Feature / Module:** Trips / Delete
- **Test Scenario:** Delete trip and observe native expense records.
- **Preconditions:** Trip with tagged expenses; isolated test data; capture rows and totals.
- **Test Data:** One trip and two tagged expenses.
- **Numbered Test Steps:** 1. Cancel delete and verify trip/expenses remain. 2. Confirm delete. 3. Reload. 4. Inspect Trips and Transactions sources and main summaries.
- **Expected Result:** Trip record deletion behavior is consistent and confirmed by reload. Personal transaction records must not be silently deleted unless product explicitly defines cascading deletion; transactions should remain in the ledger and retain an understandable tag/orphan handling. No duplicates or missing personal expenses.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Negative / Data integrity / Requirements
- **Evidence Required:** Confirmation screen; before/after Trips and Transactions source rows; main totals.

#### QA-TRP-07 — Trips remain usable with external service unavailable
- **Feature / Module:** Trips / Integration independence
- **Test Scenario:** Native trip CRUD and summaries work when external sharing service is unreachable/unconfigured.
- **Preconditions:** External URL unset; no invite code; network block any optional external host if practical.
- **Test Data:** Native trip and tagged expense.
- **Numbered Test Steps:** 1. Open Trips. 2. Create/edit trip. 3. Add tagged expense. 4. Refresh. 5. Open trip summary.
- **Expected Result:** Native trip data and summary load correctly; no external service is required; optional link errors do not block CRUD, expense display, or totals.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Independence / Resilience / Regression
- **Evidence Required:** Network log showing no required external request; saved trip and summary after reload.

#### QA-TRP-08 — Native participants requirement check
- **Feature / Module:** Trips / Participants
- **Test Scenario:** Confirm whether native participants exist independently of linked group app.
- **Preconditions:** External integration disabled.
- **Test Data:** None.
- **Numbered Test Steps:** 1. Inspect trip create/edit/detail flows. 2. Look for participant add/remove/list and per-person share. 3. Record capability.
- **Expected Result:** If no native participant workflow exists, mark not in scope/unimplemented pending product decision; do not make external members a prerequisite for trip CRUD or summaries.
- **Actual Result:**
- **Status:**
- **Priority:** Medium
- **Test Type:** Scope / Exploratory
- **Evidence Required:** Trip form/detail screenshots.

### Persistence, synchronization, and security

#### QA-DAT-01 — Refresh and reopen preserve saved records
- **Feature / Module:** Persistence / Transactions and trips
- **Test Scenario:** Saved data survives hard refresh and browser restart.
- **Preconditions:** Isolated test environment; at least one saved transaction and trip.
- **Test Data:** Unique QA transaction and native trip.
- **Numbered Test Steps:** 1. Save both. 2. Verify UI. 3. Hard refresh. 4. Close/reopen same profile. 5. Search and inspect isolated source of truth.
- **Expected Result:** Each saved item appears exactly once with unchanged fields after each reopen; source and UI agree; no optimistic-only phantom records.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Persistence / Regression
- **Evidence Required:** Before/after refresh screenshots and independent source records/IDs.

#### QA-DAT-02 — Offline create queues safely and syncs once
- **Feature / Module:** Sync / Offline queue
- **Test Scenario:** Offline mutation remains visibly queued and later persists once after reconnect.
- **Preconditions:** Disposable test environment with isolated cloud test sheet; network can be toggled.
- **Test Data:** Unique expense MYR 9.99.
- **Numbered Test Steps:** 1. Disable network. 2. Create expense. 3. Verify queued/pending status and local display. 4. Reload offline. 5. Reconnect. 6. Wait for sync confirmation. 7. Inspect cloud source and reload.
- **Expected Result:** No false success claim before server confirmation; queued row survives reload; after reconnect exactly one cloud row persists and pending item clears; totals include the expense once.
- **Actual Result:**
- **Status:**
- **Priority:** Critical
- **Test Type:** Resilience / Data integrity / Persistence
- **Evidence Required:** Sync status, pending queue count (no secrets), request timeline and isolated cloud row.

#### QA-DAT-03 — Cloud write failure is visible and recoverable
- **Feature / Module:** Sync / Error handling
- **Test Scenario:** Failed cloud mutation reports failure/queue and does not silently lose data.
- **Preconditions:** Disposable isolated environment; force test endpoint failure.
- **Test Data:** Unique expense MYR 5.00.
- **Numbered Test Steps:** 1. Make endpoint unavailable. 2. Save expense. 3. Observe user feedback and local state. 4. Restore endpoint. 5. Verify retry/persistence once.
- **Expected Result:** User sees accurate queued/error state; transaction remains recoverable locally; after recovery it is persisted once; no stale contradictory sync-success indicator.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Negative / Resilience
- **Evidence Required:** Error/queue UI, network response, subsequent isolated source row.

#### QA-DAT-04 — Concurrent updates/deletes do not resurrect or overwrite unexpectedly
- **Feature / Module:** Data integrity / Multi-tab
- **Test Scenario:** Two tabs mutate the same row and converge without duplicate or deleted-row resurrection.
- **Preconditions:** Isolated cloud test sheet; same test profile in two tabs.
- **Test Data:** One expense `QA concurrency` MYR 10.00.
- **Numbered Test Steps:** 1. Open same row in both tabs. 2. Edit in tab A. 3. Delete in tab B or edit conflicting field. 4. Refresh both and inspect source.
- **Expected Result:** App surfaces or resolves conflict deterministically; final source and UI agree; no duplicate row and no deleted transaction silently reappears. Conflict policy is currently not defined; capture actual behavior for requirement confirmation.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Concurrency / Data integrity
- **Evidence Required:** Both tabs, sync/conflict feedback, source row history.

#### QA-SEC-01 — PIN is not exposed in UI, URLs, or logs
- **Feature / Module:** Security / Sensitive data
- **Test Scenario:** Check for accidental PIN disclosure during normal access/settings operations.
- **Preconditions:** Isolated profile; test PIN configured.
- **Test Data:** Non-production test PIN only.
- **Numbered Test Steps:** 1. Enter PIN. 2. Inspect rendered page text, URL, browser console and network payloads. 3. Update PIN. 4. Recheck captured logs.
- **Expected Result:** PIN is not rendered in plaintext outside the entry field, not placed in URL, and not emitted into logs/network requests beyond documented configuration needs. Do not use a real PIN in this test.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Security / Privacy
- **Evidence Required:** Redacted console/network review; screenshots with PIN field obscured.

#### QA-SEC-02 — Untrusted input renders as text, not executable markup
- **Feature / Module:** Security / Transaction and trip text fields
- **Test Scenario:** HTML/script-like text is safely displayed.
- **Preconditions:** Isolated test ledger.
- **Test Data:** Description/note `QA <img src=x onerror=alert(1)>` and trip name `<script>alert(1)</script>`.
- **Numbered Test Steps:** 1. Save test strings. 2. Open list/detail/trip views. 3. Observe execution and rendered output. 4. Inspect persisted value.
- **Expected Result:** Text is escaped/rendered inert; no script/dialog executes; text persists without changing unrelated rows.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Security / Negative
- **Evidence Required:** Screenshot, console, persisted test string.

#### QA-SEC-03 — Unknown/malformed API response does not corrupt financial state
- **Feature / Module:** Sync / Error handling
- **Test Scenario:** Empty, malformed or unexpected data response is handled safely.
- **Preconditions:** Isolated test endpoint capable of returning malformed response.
- **Test Data:** Empty rows, duplicate IDs, missing amount/date, nonnumeric amount.
- **Numbered Test Steps:** 1. Return each fixture. 2. Load Transactions/Trips. 3. Attempt normal read/edit. 4. Compare local cache and source.
- **Expected Result:** App shows safe empty/error state or skips invalid rows with a diagnosable error; no NaN/Infinity totals; no mass deletion or silent overwrite; valid rows remain intact.
- **Actual Result:**
- **Status:**
- **Priority:** High
- **Test Type:** Negative / Robustness / Data integrity
- **Evidence Required:** Test response fixture, UI state, console errors and before/after source comparison.

## 5. Financial calculation validation scenarios

| Scenario | Independent calculation | Expected value/assertion |
|---|---|---|
| Income minus expense | MYR 5,000.00 − MYR 145.50 | Net MYR 4,854.50 |
| Expense category totals | 25.50 + 10.00 + (100 CNY × 0.60) + 50.00 | MYR 145.50 total |
| USD fallback conversion | USD 10 × 4.10 MYR/USD | MYR 41.00 |
| SGD fallback conversion | SGD 10 × 3.20 MYR/SGD | MYR 32.00 |
| JPY fallback conversion | JPY 100 × 0.028 MYR/JPY | MYR 2.80 |
| Trip JPY expense | JPY 1,000 × 0.028 MYR/JPY | MYR 28.00; trip spend JPY 1,000 |
| Trip foreign-to-trip conversion | USD 10 × 4.10 ÷ 0.028 | JPY 1,464.285714…; display normally 1,464.29 |
| Budget remaining | Budget 1,000 − spend 999.99 | MYR 0.01 |
| Budget overage | Spend 1,000.01 − budget 1,000 | MYR 0.01 over |
| Category percentages | 25/100 and 75/100 | 25% and 75%; sum 100% |
| 0% installment split | MYR 1,000 ÷ 3, rounded first two installments to 333.33; final remainder | 333.33 + 333.33 + 333.34 = MYR 1,000.00 |

**Rounding rule:** Current code formats currency to two fraction digits and installment code explicitly rounds to two digits with a final-payment remainder. A global rounding mode for raw transaction inputs, FX conversions, category percentages, and display ties is not stated. Use cent-exact test values for release assertions; obtain a product decision before treating a specific half-cent rule as a requirement.

## 6. Requirements traceability matrix

| Requirement / user objective | Test cases |
|---|---|
| Account/profile management (as currently implemented) | QA-ACC-01–05 |
| Income/expense create, edit, delete, categorize | QA-TXN-01–06, QA-TXN-10 |
| Transaction dates, currencies, precision | QA-TXN-07–09 |
| Cashflow and income/expense reports | QA-FIN-01–03 |
| Account balances and transfers | QA-ACC-05, QA-FIN-08 (scope gap) |
| Recurring transactions/commitments | QA-REC-01–03 |
| Installments | QA-INS-01–03 |
| Budgets | QA-FIN-04–05 |
| Goals | Coverage gap; product requirement needed |
| Trip CRUD, expense links, summary | QA-TRP-01–07 |
| Trip participants | QA-TRP-08 (scope gap) |
| Search/filter/sort/date ranges | QA-FIN-02, QA-FIN-06–07 |
| Persistence, refresh, history, sync | QA-TXN-01–05, QA-DAT-01–04 |
| Validation, duplicate prevention, security | QA-TXN-03, QA-TXN-06, QA-TRP-02, QA-SEC-01–03 |
| Calculation accuracy and regressions | QA-TXN-04–05, QA-TXN-09, QA-FIN-01–05, QA-REC-02–03, QA-INS-01–02, QA-TRP-03–04 |

## 7. Risks and missing requirements

1. **Rounding:** Define accepted decimal scale, rejection/rounding behavior for >2 decimals, tie-breaking mode, and whether summaries round per transaction or only at aggregate display.
2. **FX accounting:** Define whether exchange rates are locked at entry, refreshed live, manually entered, or overridden by stored base amounts; specify behavior when a rate is absent/stale and how historical reports should reproduce prior values.
3. **Account balances/transfers:** Confirm whether account/payment method is only a descriptive label or whether separate accounts and transfers are a planned requirement. No native transfer workflow was established in reviewed code.
4. **Profile/security:** PIN is a local convenience lock; define expected protection model, PIN recovery, rate limiting/lockout, multi-user identity, and trusted-device expiration if stronger account security is intended.
5. **Trip association/deletion:** Confirm whether expenses link by immutable trip ID or mutable name/tag; specify rename migration and whether deleting a trip preserves, clears, or archives expense tags.
6. **Participants:** Confirm whether native participants and per-person shares are required. External group app behavior is deliberately excluded from native acceptance.
7. **Date reporting:** Confirm whether users need arbitrary from/to ranges or month/year selection is sufficient; timezone and future-date policy should be specified.
8. **Recurring behavior:** Define missed-month catch-up, changed amount/category, pause/end dates, and retry/conflict rules. Auto-record must never be tested against live personal data.
9. **Goals:** Confirm whether savings goals/emergency reserve are first-class features with target, deadline, contribution tracking, and completion state.
10. **Audit history:** The app's ledger/source-of-truth is reviewed, but a user-visible immutable edit/delete history was not confirmed. Define whether audit trail is expected.
11. **Data access:** Define authorization/backup/export/recovery expectations for local cache and connected Sheets; do not infer security from a client-side PIN.

## 8. Test completion criteria

- All in-scope Critical and High cases pass in an isolated environment; any failure is recorded with reproduction steps, expected/actual values, severity, environment, and evidence.
- Every create/edit/delete test is checked after reload and against the isolated source of truth, not just the immediate optimistic UI.
- Independent recomputation matches app values to the approved precision and rounding policy; no duplicate, missing, resurrected, or double-counted rows remain.
- Native trip CRUD, expense association and summaries pass while all external sharing integrations are disabled/unavailable.
- Negative, boundary, offline, refresh, and duplicate-submission coverage is complete; no test has mutated live financial data.
- Scope gaps are resolved as accepted non-goals or converted into approved requirements before reporting full feature completion.

## 9. Execution record

| Build/commit | Environment | Execution date | Executed by | Passed | Failed | Blocked | Notes |
|---|---|---|---|---:|---:|---:|---|
|  |  |  |  |  |  |  |  |

