import { initPlaywright, closePlaywright, saveStorageState, getPage, BrowserType } from './services/chatgpt.ts';

async function main() {
  let browserType: BrowserType = 'chromium';
  const arg = process.argv.find((a) => a.startsWith('--browser='));
  if (arg) browserType = arg.split('=')[1] as BrowserType;
  else if (process.env.BROWSER) browserType = process.env.BROWSER as BrowserType;

  console.log(`[Login] Opening ${browserType} (headed) for manual login on ChatGPT...`);
  await initPlaywright(false, browserType);

  const p = getPage();
  if (!p) throw new Error('No page available');

  console.log('Browser opened. Log in to https://chatgpt.com/ (Google SSO recommended).');
  console.log('Waiting until the chat composer appears...');

  try {
    await p.waitForSelector('#prompt-textarea', { timeout: 300000 });
    console.log('[Login] Login detected. Saving state...');
  } catch {
    console.error('[Login] Timed out waiting for login. State not saved.');
    await closePlaywright();
    process.exit(1);
  }

  await saveStorageState();
  await closePlaywright();
  console.log('[Login] Done. You can now run "bun start".');
}

main().catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});