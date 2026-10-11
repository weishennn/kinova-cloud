import { randomBytes } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputPath = path.join(projectRoot, '.env.local');
const defaultGeminiModel = 'gemini-2.5-flash';
const appsScriptUrlPattern = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/;
const managedEnvKeys = new Set([
  'APPS_SCRIPT_URL',
  'NEXT_PUBLIC_APPS_SCRIPT_URL',
  'APPS_SCRIPT_API_KEY',
  'NEXT_PUBLIC_APPS_SCRIPT_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'NEXT_PUBLIC_APP_PIN',
]);

function getOutputPath(args) {
  let outputPath;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run setup [-- --output <path>]');
      console.log('By default, writes configuration to the project .env.local file.');
      return null;
    }
    if (arg === '--output') {
      outputPath = args[index + 1];
      if (!outputPath || outputPath.startsWith('--')) {
        throw new Error('--output requires a file path.');
      }
      index += 1;
    } else if (arg.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length);
      if (!outputPath) throw new Error('--output requires a file path.');
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return outputPath ? path.resolve(process.cwd(), outputPath) : defaultOutputPath;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function preserveUnmanagedEnvValues(filePath, managedContents) {
  if (!(await fileExists(filePath))) return managedContents;
  const existingContents = await readFile(filePath, 'utf8');
  const preservedAssignments = existingContents
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return match && !managedEnvKeys.has(match[1]);
    });
  if (preservedAssignments.length === 0) return managedContents;
  return `${managedContents.trimEnd()}\n\n# Other settings preserved from your existing environment file.\n${preservedAssignments.join('\n')}\n`;
}

function isValidAppsScriptUrl(value) {
  if (!appsScriptUrlPattern.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'script.google.com' && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function envValue(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n')}"`;
}

async function readJsonResponse(response) {
  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`The service returned an unexpected response (HTTP ${response.status}).`);
  }
  if (!response.ok || body?.success !== true) {
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function configureAndCheckAppsScript(url, apiKey) {
  let keyConfigured = false;
  try {
    const configureResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'configureEndpointKey',
        newKey: apiKey,
        apiKey,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const configured = await readJsonResponse(configureResponse);
    keyConfigured = configured.data?.configured === true;
    if (!keyConfigured) {
      throw new Error('The Apps Script endpoint did not confirm that its API key is configured.');
    }
    console.log('  Endpoint key configured.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  Endpoint key setup failed: ${message}`);
  }

  let connectionVerified = false;
  try {
    const pingUrl = new URL(url);
    pingUrl.searchParams.set('action', 'ping');
    pingUrl.searchParams.set('apiKey', apiKey);
    const pingResponse = await fetch(pingUrl, { signal: AbortSignal.timeout(20000) });
    const ping = await readJsonResponse(pingResponse);
    if (ping.data?.pong !== true || ping.data?.spreadsheetReady !== true) {
      throw new Error('The endpoint responded, but the bound Google Sheet was not confirmed as ready.');
    }
    connectionVerified = true;
    console.log(`  Live connection verified; the bound sheet has ${ping.data.sheetCount} tab(s).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  Live connection check failed: ${message}`);
  }
  return { keyConfigured, connectionVerified };
}

async function testGeminiApiKey(apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${defaultGeminiModel}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with OK.' }] }],
        generationConfig: { maxOutputTokens: 4, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini request returned HTTP ${response.status}. Check the key and Google AI Studio access.`);
  }
  try {
    const body = JSON.parse(bodyText);
    if (!body?.candidates?.[0]?.content?.parts?.length) {
      throw new Error('The API key was accepted, but Gemini returned no generated content.');
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Gemini returned an unexpected response.');
    throw error;
  }
}

async function askAppsScriptUrl(rl) {
  console.log('\nStep 1 — Google Sheets and Apps Script');
  console.log('  1. Create a Google Sheet at https://sheets.new');
  console.log('  2. In the sheet, choose Extensions → Apps Script.');
  console.log('  3. Replace the editor contents with apps-script/Code.gs and save.');
  console.log('  4. Choose Deploy → New deployment → Web app.');
  console.log('     Set “Execute as” to Me and “Who has access” to Anyone.');
  console.log('  5. Deploy and copy the Web app URL ending in /exec.');
  console.log('     The Sheet and Apps Script project should stay bound to each other.');

  while (true) {
    const value = (await rl.question('\nPaste the Web app URL (Enter for local-only mode): ')).trim();
    if (!value) return '';
    if (isValidAppsScriptUrl(value)) return value;
    console.log('  That URL does not look like an Apps Script Web app URL. Please use https://script.google.com/macros/s/.../exec.');
  }
}

async function askEndpointKey(rl) {
  const generatedKey = randomBytes(32).toString('hex');
  console.log('\nStep 2 — Endpoint security key and live connection');
  console.log('  A new 64-character key was generated. Press Enter to use it,');
  console.log('  or paste the existing endpoint key when reconnecting to a locked Sheet.');
  while (true) {
    const entered = (await rl.question(`  Endpoint key [generated ${generatedKey}]: `)).trim();
    const key = entered || generatedKey;
    if (key.length >= 32) return key;
    console.log('  The app requires an endpoint key with at least 32 characters. Try again.');
  }
}

async function askGeminiKey(rl) {
  console.log('\nStep 3 — Gemini API key (AI quick input and receipt OCR)');
  console.log('  Create a key at https://aistudio.google.com/app/apikey');
  const apiKey = (await rl.question('  Paste GEMINI_API_KEY (Enter to skip AI features): ')).trim();
  if (!apiKey) return '';

  const shouldTest = (await rl.question('  Make a small test request now? This sends “Reply with OK.” to Gemini [y/N]: ')).trim().toLowerCase();
  if (shouldTest === 'y' || shouldTest === 'yes') {
    try {
      await testGeminiApiKey(apiKey);
      console.log('  Gemini accepted the key and returned a response.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  Gemini key check failed: ${message}`);
      console.log('  The key will still be saved so you can verify it later.');
    }
  } else {
    console.log('  Skipping the Gemini request.');
  }
  return apiKey;
}

async function askPin(rl) {
  console.log('\nStep 4 — App lock PIN');
  while (true) {
    const pin = (await rl.question('  Choose a 4-digit numeric PIN [0000]: ')).trim() || '0000';
    if (/^\d{4}$/.test(pin)) return pin;
    console.log('  Please enter exactly four digits.');
  }
}

async function main() {
  const outputPath = getOutputPath(process.argv.slice(2));
  if (!outputPath) return;

  console.log('\x1b[36m');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │             CashFlow Setup Wizard            │');
  console.log('  │  Google Sheets  •  Gemini  •  App lock       │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('\x1b[0m');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (await fileExists(outputPath)) {
      const answer = (await rl.question(`Configuration file already exists at ${outputPath}. Update CashFlow settings and keep other values? [Y/n]: `)).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') {
        console.log('Setup cancelled. The existing file was left unchanged.');
        return;
      }
    }

    const appsScriptUrl = await askAppsScriptUrl(rl);
    let appsScriptApiKey = '';
    let connectionVerified = false;
    let endpointKeyConfigured = false;
    if (appsScriptUrl) {
      appsScriptApiKey = await askEndpointKey(rl);
      const status = await configureAndCheckAppsScript(appsScriptUrl, appsScriptApiKey);
      connectionVerified = status.connectionVerified;
      endpointKeyConfigured = status.keyConfigured;
      if (!endpointKeyConfigured || !connectionVerified) {
        console.log('  Check that the latest Code.gs is deployed and that you entered the current key for this Sheet.');
      }
    } else {
      console.log('\nStep 2 — Endpoint security key and live connection');
      console.log('  Skipped. The app will use browser-local storage until you configure a Sheet.');
    }

    const geminiApiKey = await askGeminiKey(rl);
    const pin = await askPin(rl);

    const contents = [
      '# Generated by CashFlow Setup Wizard. Keep this file private.',
      `APPS_SCRIPT_URL=${envValue(appsScriptUrl)}`,
      `NEXT_PUBLIC_APPS_SCRIPT_URL=${envValue(appsScriptUrl)}`,
      `APPS_SCRIPT_API_KEY=${envValue(appsScriptApiKey)}`,
      `NEXT_PUBLIC_APPS_SCRIPT_API_KEY=${envValue(appsScriptApiKey)}`,
      `GEMINI_API_KEY=${envValue(geminiApiKey)}`,
      `GEMINI_MODEL=${envValue(defaultGeminiModel)}`,
      `NEXT_PUBLIC_APP_PIN=${envValue(pin)}`,
      '',
    ].join('\n');

    console.log('\nStep 5 — Save configuration');
    const finalContents = await preserveUnmanagedEnvValues(outputPath, contents);
    await writeFile(outputPath, finalContents, { encoding: 'utf8', mode: 0o600 });
    console.log(`  Wrote ${outputPath}`);
    console.log('\nSetup summary');
    console.log(`  Google Sheets: ${appsScriptUrl ? (connectionVerified && endpointKeyConfigured ? 'connected and verified' : endpointKeyConfigured ? 'key configured; Sheet connection still needs checking' : 'URL/key saved; connection still needs checking') : 'local-only mode'}`);
    console.log(`  Gemini AI: ${geminiApiKey ? 'key saved' : 'skipped'}`);
    console.log('  App lock: PIN saved');
    console.log('\nRun locally: npm run dev');
    console.log('Create a production build: npm run build');
    console.log('Deploy: import this repository in Vercel and add the same environment variables in Project Settings.');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CashFlow setup could not finish: ${message}`);
  process.exitCode = 1;
});
