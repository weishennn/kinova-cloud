const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3055';

async function loadRoute(page, route, options) {
  const response = await page.goto(`${BASE_URL}${route}`, options);
  if (!response) {
    throw new Error(`No document response received for ${route}.`);
  }
  if (response.status() < 200 || response.status() >= 300) {
    throw new Error(`Expected ${route} to return HTTP 2xx, got ${response.status()}.`);
  }
  return response;
}

async function runTests() {
  const puppeteerModule = await import('puppeteer-core');
  const puppeteer = puppeteerModule.default || puppeteerModule;
  console.log('🚀 Starting Automated Full-Flow End-to-End Test with Edge...');

  const browser = process.env.PUPPETEER_CDP_URL
    ? await puppeteer.connect({ browserURL: process.env.PUPPETEER_CDP_URL })
    : await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Pre-seed localStorage to trust device and strictly prevent any automated writes during testing
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('cashflow_trusted_device', 'true');
    localStorage.setItem('cashflow_test_mode', 'true');
    localStorage.setItem('cashflow_recurring_commitments', '[]');
  });

  const errors = [];
  const consoleLogs = [];

  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    consoleLogs.push(`[${type}] ${text}`);
    if (type === 'error' && !text.includes('Failed to load resource')) {
      errors.push(`Console error on ${page.url()}: ${text}`);
    }
  });

  page.on('pageerror', (err) => {
    errors.push(`Page error on ${page.url()}: ${err.message}`);
  });

  try {
    // 1. Test Home Page
    console.log('\n--- 1. Testing Home Page (/) ---');
    await loadRoute(page, '/', { waitUntil: 'networkidle0', timeout: 20000 });
    const homeTitle = await page.title();
    console.log(`✓ Home page loaded. Title: "${homeTitle}"`);
    await new Promise((r) => setTimeout(r, 2000));

    // Keep the full UI flow isolated: apiRequest routes every Sheets operation to its local test store.
    const localModeBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('button')).find((button) =>
        /use local storage only/i.test(button.textContent || '')
      )
    );
    if (localModeBtn.asElement()) {
      await localModeBtn.asElement().click();
      await page.waitForFunction(
        () => localStorage.getItem('cashflow_local_mode_chosen') === 'true',
        { timeout: 10000 }
      );
    }
    const testModeEnabled = await page.evaluate(() =>
      localStorage.getItem('cashflow_test_mode') === 'true'
    );
    if (!testModeEnabled) {
      throw new Error('The E2E browser did not remain in zero-write local test mode.');
    }
    console.log('✓ Test mode active; Sheets reads and writes use the isolated local test store.');

    // 2. Test Transactions Page
    console.log('\n--- 2. Testing Transactions Page (/transactions) ---');
    await loadRoute(page, '/transactions', { waitUntil: 'networkidle0', timeout: 20000 });
    console.log('✓ /transactions loaded');
    await new Promise((r) => setTimeout(r, 3000));

    // Check transaction rows
    const txRows = await page.$$('.cursor-pointer.group');
    console.log(`✓ Found ${txRows.length} transaction card rows on /transactions`);

    // 3. Test Clicking "Record Payment" button
    console.log('\n--- 3. Testing Record Payment Modal ---');
    const recordBtn = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find((button) =>
        /record payment|add expense/i.test(
          `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`
        )
      );
    });
    if (!recordBtn.asElement()) {
      throw new Error('Could not find the record-entry action on /transactions.');
    }
    await recordBtn.asElement().click();
    await page.waitForSelector('#record-transaction-dialog #record-amount', { timeout: 5000 });
    const modalHeader = await page.$eval('#record-modal-title', (el) => el.textContent || '');
    console.log(`✓ Record Modal opened with header: "${modalHeader}"`);

    // A zero amount must be rejected without closing the form or writing a row.
    await page.click('#record-amount');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.type('#record-amount', '0');
    await page.click('#record-transaction-dialog form button[type="submit"]');
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-sonner-toast]')).some((toast) =>
        (toast.textContent || '').includes('Enter an amount greater than zero')
      ),
      { timeout: 3000 }
    );
    if (!(await page.$('#record-transaction-dialog #record-amount'))) {
      throw new Error('The zero-amount validation closed the record form unexpectedly.');
    }
    console.log('✓ Zero amount rejected and the record form stayed open.');

    // 4. Exercise create, edit, and delete using only this disposable browser's local test store.
    console.log('\n--- 4. Testing Transaction Create, Edit, and Delete ---');
    const qaDescription = `Codex QA local ${Date.now()}`;
    const editedDescription = `${qaDescription} edited`;
    await page.click('#record-amount');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.type('#record-amount', '12.34');
    await page.type('#record-description', qaDescription);
    await page.click('#record-transaction-dialog form button[type="submit"]', { clickCount: 2, delay: 20 });
    await page.waitForFunction(
      (description) => Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
        .filter((card) => (card.getAttribute('aria-label') || '').includes(description)).length === 1,
      { timeout: 10000 },
      qaDescription
    );
    console.log('✓ New expense appears exactly once after a rapid double submit.');
    await page.waitForSelector('#record-transaction-dialog', { hidden: true, timeout: 5000 });

    const qaCard = await page.evaluateHandle((description) =>
      Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
        .find((card) => (card.getAttribute('aria-label') || '').includes(description)) || null,
      qaDescription
    );
    if (!qaCard.asElement()) throw new Error('Could not find the isolated QA transaction card.');
    await qaCard.asElement().click();
    await page.waitForSelector('[role="dialog"][aria-labelledby="transaction-details-title"]', { timeout: 5000 });
    const detailEditButton = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) =>
        /edit transaction|edit this month/i.test(button.textContent || '')
      ) || null
    );
    if (!detailEditButton.asElement()) throw new Error('Could not find Edit in the transaction detail dialog.');
    await detailEditButton.asElement().click();
    await page.waitForSelector('#record-transaction-dialog #record-amount', { timeout: 5000 });
    const prefilledTransaction = await page.evaluate(() => ({
      amount: document.querySelector('#record-amount')?.value || '',
      description: document.querySelector('#record-description')?.value || '',
    }));
    if (prefilledTransaction.amount !== '12.34' || prefilledTransaction.description !== qaDescription) {
      throw new Error('The edit form did not preserve the saved amount and description.');
    }
    await page.click('#record-amount');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.type('#record-amount', '23.45');
    await page.click('#record-description');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.type('#record-description', editedDescription);
    await page.click('#record-transaction-dialog form button[type="submit"]');
    await page.waitForFunction(
      (description) => Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
        .filter((card) => {
          const label = card.getAttribute('aria-label') || '';
          return label.includes(description) && label.includes('RM 23.45');
        }).length === 1,
      { timeout: 10000 },
      editedDescription
    );
    console.log('✓ Edit saves the updated amount and description without duplicating the row.');
    await page.waitForSelector('#record-transaction-dialog', { hidden: true, timeout: 5000 });

    const quickEditButton = await page.evaluateHandle((description) => {
      const card = Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
        .find((candidate) => (candidate.getAttribute('aria-label') || '').includes(description));
      return card?.querySelector('button[title="Edit transaction"]') || null;
    }, editedDescription);
    if (!quickEditButton.asElement()) throw new Error('Could not find the desktop quick edit action.');
    await quickEditButton.asElement().click();
    await page.waitForSelector('#record-transaction-dialog #record-description', { timeout: 5000 });
    const quickEditPrefill = await page.$eval('#record-description', (input) => input.value);
    if (quickEditPrefill !== editedDescription) throw new Error('Desktop quick edit did not open the selected transaction.');
    const editCloseButton = await page.$('#record-transaction-dialog button[aria-label="Close transaction form"]');
    if (!editCloseButton) throw new Error('Could not close the desktop quick edit form.');
    await editCloseButton.click();
    await page.waitForSelector('#record-transaction-dialog', { hidden: true, timeout: 5000 });
    console.log('✓ Desktop quick edit opens the same saved transaction.');

    const deleteButton = await page.evaluateHandle((description) => {
      const card = Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
        .find((candidate) => (candidate.getAttribute('aria-label') || '').includes(description));
      return card?.querySelector('button[title="Delete transaction"]') || null;
    }, editedDescription);
    if (!deleteButton.asElement()) throw new Error('Could not find the transaction delete action.');
    await deleteButton.asElement().click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[role="dialog"] h2'))
        .some((heading) => heading.textContent === 'Delete Transaction?'),
      { timeout: 5000 }
    );
    const confirmDeleteButton = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) =>
        button.textContent?.trim() === 'Delete'
      ) || null
    );
    if (!confirmDeleteButton.asElement()) throw new Error('Could not find the delete confirmation action.');
    await confirmDeleteButton.asElement().click();
    await page.waitForFunction(
      (description) => !Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
        .some((card) => (card.getAttribute('aria-label') || '').includes(description)),
      { timeout: 10000 },
      editedDescription
    );
    await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
    await page.waitForFunction(
      (description) => !Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
        .some((card) => (card.getAttribute('aria-label') || '').includes(description)),
      { timeout: 10000 },
      editedDescription
    );
    console.log('✓ Confirmed delete stays removed after a full page reload.');

    // Income and investments have different accounting meanings and must remain
    // distinguishable in accessible labels, type filters, and cash-flow totals.
    async function openRecordForm() {
      if (await page.$('#record-transaction-dialog #record-amount')) return;
      const button = await page.evaluateHandle(() =>
        Array.from(document.querySelectorAll('button')).find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(candidate).visibility !== 'hidden';
          return visible && /record payment|add expense/i.test(
            `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`
          );
        }) || null
      );
      if (!button.asElement()) throw new Error('Could not reopen the record-entry form.');
      await button.asElement().click();
      try {
        await page.waitForSelector('#record-transaction-dialog #record-amount', { timeout: 5000 });
      } catch (error) {
        const pageState = await page.evaluate(() => ({
          url: location.pathname,
          dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((dialog) => dialog.textContent?.trim().slice(0, 100)),
          matchingButtons: Array.from(document.querySelectorAll('button')).filter((candidate) =>
            /record payment|add expense/i.test(`${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`)
          ).map((candidate) => ({ text: candidate.textContent?.trim(), label: candidate.getAttribute('aria-label'), visible: candidate.getBoundingClientRect().width > 0 })),
        }));
        throw new Error(`Record form did not open: ${JSON.stringify(pageState)}. ${error.message}`);
      }
    }

    async function fillAndSubmit(amount, description) {
      await page.click('#record-amount');
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.type('#record-amount', amount);
      await page.click('#record-description');
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.type('#record-description', description);
      await page.click('#record-transaction-dialog form button[type="submit"]');
      await page.waitForSelector('#record-transaction-dialog', { hidden: true, timeout: 5000 });
      await page.waitForFunction(
        (labelPart) => Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
          .some((card) => (card.getAttribute('aria-label') || '').includes(labelPart)),
        { timeout: 10000 },
        description
      );
    }

    const incomeDescription = `Codex QA income ${Date.now()}`;
    await openRecordForm();
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('#record-transaction-dialog form button'))
        .find((candidate) => candidate.textContent?.trim() === 'Income');
      button?.click();
    });
    await fillAndSubmit('50.00', incomeDescription);
    const incomeCard = await page.$eval(
      '[aria-label^="View transaction "]',
      (card) => card.getAttribute('aria-label') || ''
    );
    if (!incomeCard.includes(', income RM 50.00')) {
      throw new Error(`Income transaction label does not announce the saved type: ${incomeCard}`);
    }
    console.log('✓ Income is saved and announced as income.');

    const investmentDescription = `Codex QA investment ${Date.now()}`;
    await openRecordForm();
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('#record-transaction-dialog form button'));
      buttons.find((candidate) => candidate.textContent?.trim() === 'Investment')?.click();
    });
    await page.click('[aria-label="Select category Other Savings"]');
    await fillAndSubmit('15.25', investmentDescription);
    const investmentCard = await page.evaluate((description) =>
      Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
        .find((card) => (card.getAttribute('aria-label') || '').includes(description))
        ?.getAttribute('aria-label') || '',
      investmentDescription
    );
    if (!investmentCard.includes(', investment RM 15.25')) {
      throw new Error(`Investment transaction label does not announce the saved type: ${investmentCard}`);
    }
    console.log('✓ Investment is saved and announced as investment.');

    await page.waitForFunction(() => {
      const summaryValues = Array.from(document.querySelectorAll('.grid.grid-cols-2 .font-mono'))
        .map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim());
      return summaryValues.includes('RM 50.00') && summaryValues.includes('RM 0.00');
    }, { timeout: 10000 });
    console.log('✓ Income contributes to the income total; investment does not inflate expenses.');

    await loadRoute(page, '/', { waitUntil: 'networkidle0', timeout: 20000 });
    await page.waitForFunction(() => {
      const groups = Array.from(document.querySelectorAll('dl[aria-label="Cash flow totals"] > div'))
        .map((group) => (group.textContent || '').replace(/\s+/g, ' ').trim());
      return groups.some((text) => text.includes('Income') && text.includes('RM 50.00')) &&
        groups.some((text) => text.includes('Expenses') && text.includes('RM 0.00')) &&
        groups.some((text) => text.includes('Invested') && text.includes('RM 15.25'));
    }, { timeout: 10000 });
    console.log('✓ Dashboard keeps income, expenses, invested total, and net cash flow in their intended buckets.');
    await loadRoute(page, '/transactions', { waitUntil: 'networkidle0', timeout: 20000 });
    await page.waitForFunction(
      (descriptions) => descriptions.every((description) =>
        Array.from(document.querySelectorAll('[aria-label^="View transaction "]'))
          .some((card) => (card.getAttribute('aria-label') || '').includes(description))
      ),
      { timeout: 10000 },
      [incomeDescription, investmentDescription]
    );

    const clickTransactionFilter = async (filter) => {
      const button = await page.evaluateHandle((value) =>
        Array.from(document.querySelectorAll('.cockpit-segmented-control button'))
          .find((candidate) => candidate.textContent?.trim() === value) || null,
        filter
      );
      if (!button.asElement()) throw new Error(`Could not find the ${filter} transaction filter.`);
      await button.asElement().click();
      await new Promise((resolve) => setTimeout(resolve, 250));
    };

    await clickTransactionFilter('income');
    const incomeFilterCount = await page.$$eval('[aria-label^="View transaction "]', (cards) => cards.length);
    if (incomeFilterCount !== 1 || !(await page.$(`[aria-label*="${incomeDescription}"]`))) {
      throw new Error('Income type filter did not isolate the income record.');
    }
    await clickTransactionFilter('investment');
    const investmentFilterCount = await page.$$eval('[aria-label^="View transaction "]', (cards) => cards.length);
    if (investmentFilterCount !== 1 || !(await page.$(`[aria-label*="${investmentDescription}"]`))) {
      throw new Error('Investment type filter did not isolate the investment record.');
    }
    await clickTransactionFilter('all');

    const searchInput = await page.$('input[type="search"]');
    if (!searchInput) throw new Error('Could not find the transaction search field.');
    await searchInput.click();
    await page.keyboard.type(investmentDescription);
    const searchCount = await page.$$eval('[aria-label^="View transaction "]', (cards) => cards.length);
    if (searchCount !== 1 || !(await page.$(`[aria-label*="${investmentDescription}"]`))) {
      throw new Error('Transaction search did not isolate the matching investment.');
    }
    await searchInput.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(`no-match-${Date.now()}`);
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label^="View transaction "]').length === 0 &&
        Array.from(document.querySelectorAll('p')).some((paragraph) => paragraph.textContent === 'No transactions found'),
      { timeout: 5000 }
    );
    const clearSearchButton = await page.$('button[aria-label="Clear search query"]');
    if (!clearSearchButton) throw new Error('The empty search result did not offer a clear-search action.');
    await clearSearchButton.click();
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label^="View transaction "]').length === 2,
      { timeout: 5000 }
    );
    await clickTransactionFilter('all');
    console.log('✓ Type filters, matching search, empty search state, and clear-search recovery work.');

    // 5. Test Ongoing Installment Plan Card Click -> Edit Installment Modal
    console.log('\n--- 5. Testing Ongoing Installment Plan Card Click ---');
    await loadRoute(page, '/', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    const clickableCards = await page.$$('div[role="button"][tabindex="0"]');
    const installmentCardIndex = await page.$$eval(
      'div[role="button"][tabindex="0"]',
      (cards) => cards.findIndex((card) => /active installment|ongoing installment|debt commitment/i.test(card.textContent || ''))
    );
    const instCard = installmentCardIndex >= 0 ? clickableCards[installmentCardIndex] : null;
    if (instCard) {
      console.log('Clicking ongoing installment card...');
      await instCard.click();
      await new Promise((r) => setTimeout(r, 1000));
      const modalHeader = await page.$eval('h2', (el) => el.textContent).catch(() => '');
      console.log(`✓ Installment Edit Modal opened with header: "${modalHeader}"`);
      // Close modal
      const closeBtn = await page.$('button svg.lucide-x');
      if (closeBtn) {
        await closeBtn.click();
      } else {
        const anyClose = await page.$('button.rounded-xl');
        if (anyClose) await anyClose.click();
      }
      await new Promise((r) => setTimeout(r, 500));
    } else {
      console.log('ℹ️ No active installment card currently rendered on dashboard.');
    }

    // 6. Smoke test all app routes at desktop size.
    const otherRoutes = ['/budget', '/investments', '/trips', '/invoices', '/analytics', '/settings', '/privacy'];
    for (const route of otherRoutes) {
      console.log(`\n--- Testing ${route} ---`);
      const response = await loadRoute(page, route, { waitUntil: 'networkidle0', timeout: 20000 });
      console.log(`✓ ${route} returned HTTP ${response.status()}`);
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Check narrow phone, tablet, and desktop layouts for horizontal overflow on key flows.
    console.log('\n--- 7. Testing Responsive Layouts ---');
    const responsiveSizes = [
      { width: 320, height: 720 },
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ];
    for (const viewport of responsiveSizes) {
      await page.setViewport(viewport);
      for (const route of ['/', '/transactions', '/budget', '/analytics']) {
        await loadRoute(page, route, { waitUntil: 'networkidle0', timeout: 20000 });
        const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        if (hasHorizontalOverflow) {
          throw new Error(`Horizontal overflow detected on ${route} at ${viewport.width}px width.`);
        }
        console.log(`✓ ${route} fits ${viewport.width}px without horizontal overflow.`);
      }
    }

  } catch (err) {
    errors.push(`Test execution error: ${err.message}`);
    console.error('Test execution failed:', err);
  } finally {
    await browser.close();
  }

  console.log('\n=======================================');
  console.log(`Total Errors Encountered: ${errors.length}`);
  if (errors.length > 0) {
    console.log('Errors List:');
    errors.forEach((e) => console.log('❌', e));
  } else {
    console.log('🎉 ALL PAGES & ACTIONS TESTED WITH 0 ERRORS!');
  }
  console.log('=======================================');

  if (errors.length > 0) {
    process.exit(1);
  }
}

runTests();
