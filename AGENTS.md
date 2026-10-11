<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 🛡️ STRICT AGENT SCOPE & DATA PRIVACY POLICY (数据绝对安全与禁触准则)

**CRITICAL MANDATE FOR ALL AI AGENTS & MODELS WORKING ON THIS PROJECT**:

1. **NEVER TOUCH, INSERT, MODIFY, OR DELETE REAL USER FINANCIAL DATA UNLESS EXPLICITLY INSTRUCTED BY THE USER**:
   - Do NOT run ad-hoc scripts that write, mutate, or delete transactions or rows in Google Sheets unless the user explicitly commands it (e.g., "delete transaction X", "clean up months 2..6").
   - Do NOT execute automated background hooks that silently insert records.

2. **ZERO UNPROMPTED AUTO-RECORDING**:
   - `DEFAULT_COMMITMENTS` must remain empty `[]`. NEVER insert synthetic or dummy recurring records (like Insurance or Parents Allowance) into the user's database.
   - Installments must NEVER pre-insert rows into future months.
   - The user must explicitly confirm or manually record transactions.

3. **AUTOMATED TESTS MUST BE 100% ISOLATED (ZERO-WRITE)**:
   - When running test scripts (e.g. `scripts/test_ui_flow.js`), ALWAYS pre-seed `cashflow_test_mode = 'true'` so that no background tasks or modals write to live Google Sheets.

4. **ALWAYS VERIFY USER INTENT FOR ANY DATA REPAIR**:
   - If a task involves repairing corrupted data or reconciling sheets, state clearly what will be touched and verify user intent before making any mutations.
