const puppeteer = require('puppeteer-core');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3055';

async function runTests() {
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
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 20000 });
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
    await page.goto(`${BASE_URL}/transactions`, { waitUntil: 'networkidle0', timeout: 20000 });
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
    console.log('✓ Confirmed delete removes the QA transaction from the list.');

    // 5. Test Ongoing Installment Plan Card Click -> Edit Installment Modal
    console.log('\n--- 5. Testing Ongoing Installment Plan Card Click ---');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 20000 });
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
    const otherRoutes = ['/budget', '/investments', '/trips', '/invoices', '/analytics', '/settings', '/privacy', '/redesign'];
    for (const route of otherRoutes) {
      console.log(`\n--- Testing ${route} ---`);
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle0', timeout: 20000 });
      console.log(`✓ ${route} loaded successfully`);
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Check narrow mobile layout for horizontal overflow on key flows.
    console.log('\n--- 7. Testing Mobile Layout ---');
    await page.setViewport({ width: 390, height: 844 });
    for (const route of ['/', '/transactions', '/budget', '/analytics']) {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle0', timeout: 20000 });
      const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (hasHorizontalOverflow) throw new Error(`Horizontal overflow detected on ${route} at 390px width.`);
      console.log(`✓ ${route} fits a 390px viewport without horizontal overflow.`);
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
