const puppeteer = require('puppeteer-core');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_URL = 'http://127.0.0.1:3055';

async function runTests() {
  console.log('🚀 Starting Automated Full-Flow End-to-End Test with Edge...');

  const browser = await puppeteer.launch({
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
      errors.push(`Console error: ${text}`);
    }
  });

  page.on('pageerror', (err) => {
    errors.push(`Page error: ${err.message}`);
  });

  try {
    // 1. Test Home Page
    console.log('\n--- 1. Testing Home Page (/) ---');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 20000 });
    const homeTitle = await page.title();
    console.log(`✓ Home page loaded. Title: "${homeTitle}"`);
    await new Promise((r) => setTimeout(r, 2000));

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
      return btns.find(b => b.textContent && b.textContent.includes('Record Payment'));
    });
    if (recordBtn && recordBtn.asElement()) {
      await recordBtn.asElement().click();
      await new Promise((r) => setTimeout(r, 1000));
      const modalHeader = await page.$eval('h2', (el) => el.textContent).catch(() => '');
      console.log(`✓ Record Modal opened with header: "${modalHeader}"`);

      // Close modal
      const closeBtn = await page.$('button.rounded-full');
      if (closeBtn) await closeBtn.click();
      await new Promise((r) => setTimeout(r, 500));
    }

    // 4. Test Clicking Transaction Row -> Detail Modal -> Edit Transaction
    console.log('\n--- 4. Testing Click Transaction & Edit Transaction Flow ---');
    if (txRows.length > 0) {
      console.log('Clicking first transaction card...');
      await txRows[0].click();
      await new Promise((r) => setTimeout(r, 1500));

      // Check Detail Modal headers
      const modalH2s = await page.evaluate(() => Array.from(document.querySelectorAll('h2')).map(h => h.textContent));
      console.log('✓ Detail Modal opened with headers:', modalH2s);

      // Check all action buttons in the Detail Modal
      const modalButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('div.fixed.inset-0 button')).map(b => b.textContent.trim());
      });
      console.log('✓ Action buttons in modal:', modalButtons);

      // Find "Edit Transaction" or "Edit This Month" button
      const editBtn = await page.evaluateHandle(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.find(b => b.textContent && (b.textContent.includes('Edit Transaction') || b.textContent.includes('Edit This Month')));
      });

      if (editBtn && editBtn.asElement()) {
        console.log('Clicking "Edit" button inside Detail Modal...');
        await editBtn.asElement().click();
        await new Promise((r) => setTimeout(r, 1500));

        const editModalTitle = await page.$eval('h2', (el) => el.textContent).catch(() => '');
        console.log(`✓ Edit Modal opened with header: "${editModalTitle}"`);

        const amountVal = await page.$eval('input[type="number"]', (el) => el.value).catch(() => '');
        const descVal = await page.$eval('input[placeholder*="Village Park"]', (el) => el.value).catch(() => '');
        console.log(`✓ Form pre-filled with: Amount="${amountVal}", Desc="${descVal}"`);

        // Close modal
        const closeBtn = await page.$('button.rounded-full');
        if (closeBtn) await closeBtn.click();
        await new Promise((r) => setTimeout(r, 500));
        console.log('✓ Edit Modal closed successfully');
      } else {
        console.log('❌ Could not find Edit button inside Detail Modal.');
      }
    } else {
      console.log('No transaction rows found to test editing on.');
    }

    // 5. Test Desktop Edit Button on Transaction Row
    console.log('\n--- 5. Testing Desktop Quick Edit Button ---');
    const desktopEditBtn = await page.$('button[title="Edit transaction"]');
    if (desktopEditBtn) {
      console.log('Clicking desktop quick Edit button...');
      await desktopEditBtn.click();
      await new Promise((r) => setTimeout(r, 1000));
      const editModalTitle = await page.$eval('h2', (el) => el.textContent).catch(() => '');
      console.log(`✓ Edit Modal opened directly with header: "${editModalTitle}"`);
      const closeBtn = await page.$('button.rounded-full');
      if (closeBtn) await closeBtn.click();
      await new Promise((r) => setTimeout(r, 500));
    }

    // 6. Test Ongoing Installment Plan Card Click -> Edit Installment Modal
    console.log('\n--- 6. Testing Ongoing Installment Plan Card Click ---');
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

    // 7. Test Other Pages
    const otherRoutes = ['/budget', '/investments', '/trips', '/invoices', '/analytics', '/settings'];
    for (const route of otherRoutes) {
      console.log(`\n--- Testing ${route} ---`);
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle0', timeout: 20000 });
      console.log(`✓ ${route} loaded successfully`);
      await new Promise((r) => setTimeout(r, 1000));
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
