import { chromium, firefox, webkit, Browser, BrowserContext, Page, Locator } from 'playwright';
import path from 'path';
import fs from 'fs';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

const USER_DATA_DIR = path.resolve('./userData');
const STORAGE_STATE_PATH = path.resolve('./storageState.json');
const UPLOADS_DIR = path.resolve('./uploads');

let context: BrowserContext | null = null;
let page: Page | null = null;
let loginVerified = false;

const launchOpts = { headless: true, browserType: 'chromium' as BrowserType };

export const LOGIN_REQUIRED = new Error('Login required. Run "bun run login" to authenticate on ChatGPT.');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

const uiMutex = new Mutex();

async function findVisible(p: Page, selectors: string[], timeout = 3000): Promise<Locator | null> {
  for (const sel of selectors) {
    try {
      const loc = p.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch {
      // try next selector
    }
  }
  return null;
}

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (context) return;
  launchOpts.headless = headless;
  launchOpts.browserType = browserType;

  let engine: any;
  let channel: string | undefined;
  switch (browserType) {
    case 'firefox': engine = firefox; break;
    case 'webkit': engine = webkit; break;
    case 'chrome': engine = chromium; channel = 'chrome'; break;
    case 'edge': engine = chromium; channel = 'msedge'; break;
    default: engine = chromium; break;
  }

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const args: string[] = [];
  const ignoreDefaultArgs: string[] = [];
  if (browserType === 'chromium' || browserType === 'chrome' || browserType === 'edge') {
    args.push('--disable-blink-features=AutomationControlled');
    ignoreDefaultArgs.push('--enable-automation');
  }

  const launched = await engine.launchPersistentContext(USER_DATA_DIR, {
    headless,
    channel,
    args,
    ignoreDefaultArgs,
    viewport: { width: 1280, height: 900 },
  });

  context = launched;

  await launched.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Restore cookie backup if available (main source of truth is userData dir)
  if (fs.existsSync(STORAGE_STATE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
      if (state.cookies?.length) {
        await launched.addCookies(state.cookies);
      }
    } catch (e) {
      console.warn('[ChatGPT] Could not load storage state:', (e as Error).message);
    }
  }

  page = launched.pages()[0] || (await launched.newPage());
  const openedPage = page!;
  try {
    await openedPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    loginVerified = false;
  } catch (e) {
    console.warn('[ChatGPT] Could not load chatgpt.com at startup:', (e as Error).message);
  }
  console.log(`[ChatGPT] Browser opened (${browserType}, headless=${headless}).`);
}

export function getPage(): Page | null {
  return page;
}
export async function closePlaywright() {
  if (context) {
    await context.close();
    context = null;
    page = null;
    loginVerified = false;
  }
}

export async function saveStorageState() {
  if (!context) return;
  const state = await context.storageState();
  fs.writeFileSync(STORAGE_STATE_PATH, JSON.stringify(state, null, 2));
  console.log('[ChatGPT] Storage state saved.');
}

async function ensureLoggedIn(): Promise<boolean> {
  if (loginVerified) return true;
  if (!page) throw new Error('Playwright not initialized');

  if (!(await checkLoggedIn())) {
    console.warn('[ChatGPT] Login check failed; restarting browser to restore the session...');
    await restartBrowser();
    if (!page) return false;
  }
  const ok = await checkLoggedIn();
  if (ok) loginVerified = true;
  return ok;
}

async function checkLoggedIn(): Promise<boolean> {
  if (!page) return false;
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  try {
    await page.locator('#prompt-textarea').first().waitFor({ state: 'attached', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

export async function getLoginStatus(): Promise<{ loggedIn: boolean; url?: string }> {
  try {
    if (!page) return { loggedIn: false };
    const hasComposer = await page
      .locator('#prompt-textarea')
      .first()
      .waitFor({ state: 'attached', timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (hasComposer) loginVerified = true;
    return { loggedIn: hasComposer, url: page.url() };
  } catch {
    return { loggedIn: false };
  }
}

export async function restartBrowser() {
  await closePlaywright();
  await initPlaywright(launchOpts.headless, launchOpts.browserType);
}

async function startNewChat() {
  if (!page) throw new Error('Playwright not initialized');
  const btn = await findVisible(page, [
    '[data-testid="create-new-chat-button"]',
    '[data-testid="new-chat-button"]',
    'a[href="/new"]',
    'button:has-text("New chat")',
  ], 4000);
  if (btn) {
    await btn.click().catch(() => {});
    await sleep(800);
  }
}

async function sendPrompt(p: Page, text: string) {
  const composer = p.locator('#prompt-textarea').first();
  await composer.waitFor({ state: 'visible', timeout: 30000 });
  await composer.click();
  await composer.fill(text);
  await sleep(200);

  const btn = await findVisible(p, [
    '[data-testid="send-button"]',
    '[data-testid="composer-send-button"]',
    'button[type="submit"]',
  ], 4000);
  if (btn) {
    await btn.click().catch(async () => {
      await composer.press('Enter');
    });
  } else {
    await composer.press('Enter');
  }
}

export interface Attachment {
  filename: string;
  mime: string;
  data: Buffer;
}

async function attachFiles(p: Page, files: Attachment[]) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const paths: string[] = [];
  try {
    for (const f of files) {
      const fp = path.join(UPLOADS_DIR, f.filename);
      fs.writeFileSync(fp, f.data);
      paths.push(fp);
    }
    const input = p.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 15000 });
    await input.setInputFiles(paths);
    await sleep(1200);
  } finally {
    for (const fp of paths) fs.rmSync(fp, { force: true });
  }
}

async function readAssistantStream(
  p: Page,
  onDelta: (delta: string) => Promise<void> | void,
  timeoutMs: number
): Promise<string> {
  const msg = p.locator('[data-message-author-role="assistant"]').last();
  await msg.waitFor({ state: 'attached', timeout: 30000 });

  const contentLoc = msg.locator('.markdown').first();
  const readText = async (): Promise<string> => {
    try {
      const visible = await contentLoc.first().waitFor({ state: 'visible', timeout: 1000 }).catch(() => null);
      if (!visible) {
        const raw = await msg.innerText().catch(() => '');
        return raw;
      }
      return await contentLoc.first().innerText().catch(() => '');
    } catch {
      return '';
    }
  };

  let accumulated = '';
  let stalled = 0;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const text = await readText();
    if (text.length > accumulated.length) {
      const delta = text.slice(accumulated.length);
      accumulated = text;
      stalled = 0;
      if (delta && onDelta) await onDelta(delta);
    } else {
      stalled++;
    }

    const stopBtn = await findVisible(p, ['[data-testid="stop-button"]'], 500);
    if (!stopBtn) {
      // Generation finished streaming. Wait a generous quiet period for the
      // full answer to render (covers "Analyzing image"/thinking pauses).
      if (stalled >= 60) break;
    } else {
      stalled = 0;
    }

    await sleep(150);
  }

  for (let i = 0; i < 10; i++) {
    const text = await readText();
    if (text.length > accumulated.length) {
      const delta = text.slice(accumulated.length);
      accumulated = text;
      if (delta && onDelta) await onDelta(delta);
    }
    await sleep(250);
  }

  return accumulated;
}

export async function generateImage(
  prompt: string,
  timeoutMs = 300000
): Promise<{ url: string; text?: string }> {
  if (!page) throw new Error('Playwright not initialized');

  const release = await uiMutex.acquire();
  try {
    if (!(await ensureLoggedIn())) throw LOGIN_REQUIRED;
    const p = page;
    if (!p) throw new Error('Playwright not initialized');
    await startNewChat();
    await sendPrompt(p, 'Generate an image based on this prompt. Output ONLY the image, no text.\n\n' + prompt);

    const readGeneratedSrc = async (): Promise<string | null> => {
      return p
        .evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img'));
          for (const el of imgs) {
            const s = (el as HTMLImageElement).src || '';
            const alt = (el as HTMLImageElement).alt || '';
            if (
              alt.startsWith('Generated image') ||
              s.includes('/backend-api/estuary/content?') ||
              s.includes('oaiusercontent.com') ||
              s.includes('dalle')
            ) {
              return s;
            }
          }
          return null;
        })
        .catch(() => null);
    };

    // The generated image may render outside the chat message flow on the page,
    // so detect it page-wide. Wait for the stop button to disappear (or the
    // image src to stay stable for 2s) before reporting success.
    const start = Date.now();
    let lastSrc: string | null = null;
    let stableSince = 0;
    while (Date.now() - start < timeoutMs) {
      const src = await readGeneratedSrc();
      const stopBtn = await findVisible(p, ['[data-testid="stop-button"]'], 300);
      if (src) {
        if (!stopBtn) return { url: src };
        if (src === lastSrc) {
          stableSince += 500;
          if (stableSince >= 2000) return { url: src };
        } else {
          stableSince = 0;
          lastSrc = src;
        }
      }
      await sleep(500);
    }

    const src = await readGeneratedSrc();
    if (src) return { url: src };
    const text = await page
      .locator('[data-message-author-role="assistant"] .markdown')
      .last()
      .innerText()
      .catch(() => '');
    throw new Error('Image generation timed out' + (text ? `: ${text.slice(0, 300)}` : ''));
  } finally {
    release();
  }
}

export function getContext(): BrowserContext | null {
  return context;
}

export async function askChatGPT(
  prompt: string,
  onDelta?: (delta: string) => Promise<void> | void,
  timeoutMs = 300000,
  attachments: Attachment[] = []
): Promise<{ text: string }> {
  if (!page) throw new Error('Playwright not initialized');

  const release = await uiMutex.acquire();
  try {
    if (!(await ensureLoggedIn())) {
      throw LOGIN_REQUIRED;
    }

    await startNewChat();
    if (attachments.length) await attachFiles(page, attachments);
    await sendPrompt(page, prompt);

    let text = '';
    try {
      text = await readAssistantStream(
        page,
        async (delta) => {
          text += delta;
          if (onDelta) await onDelta(delta);
        },
        timeoutMs
      );
    } catch (e) {
      // Retry login verification once: the token may have expired mid-flight
      loginVerified = false;
      if (!(await ensureLoggedIn())) throw LOGIN_REQUIRED;
      await sleep(1000);
      text = await readAssistantStream(page, async (delta) => {
        text += delta;
        if (onDelta) await onDelta(delta);
      }, timeoutMs);
    }

    return { text };
  } finally {
    release();
  }
}
