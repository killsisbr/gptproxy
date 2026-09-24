import { chromium, firefox, webkit, Browser, BrowserContext, Page, Locator } from 'playwright';
import path from 'path';
import fs from 'fs';
import { gptProxySessions, GptProxySession } from './sessions.ts';
import { recordTurn } from './telemetry.ts';

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

const LOGGED_IN_SELECTORS = [
  '#prompt-textarea',
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask" i]',
  'textarea[placeholder*="Message" i]',
  '[data-testid="composer-speech-button"]',
  '[data-testid="composer-send-button"]',
  '[data-testid="new-chat-button"]',
  'a[href^="/c/"]',
];

async function hasLoggedInUi(timeout = 1500): Promise<boolean> {
  if (!page) return false;
  for (const selector of LOGGED_IN_SELECTORS) {
    const ok = await page
      .locator(selector)
      .first()
      .waitFor({ state: 'attached', timeout })
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function checkLoggedIn(): Promise<boolean> {
  if (!page) return false;
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return hasLoggedInUi(5000);
}

export async function getLoginStatus(): Promise<{ loggedIn: boolean; url?: string }> {
  try {
    if (!page) return { loggedIn: false };
    const loggedIn = await hasLoggedInUi(1500);
    if (loggedIn) loginVerified = true;
    return { loggedIn, url: page.url() };
  } catch {
    return { loggedIn: false };
  }
}

export async function restartBrowser() {
  await closePlaywright();
  await initPlaywright(launchOpts.headless, launchOpts.browserType);
}

/**
 * Matches a settled ChatGPT conversation URL (`https://chatgpt.com/c/<id>`).
 * ChatGPT briefly renders a CLIENT-SIDE placeholder URL of the form
 * `/c/WEB:<uuid>` immediately after the first send, before the backend
 * assigns and the frontend adopts the real conversation id; that placeholder
 * never reappears as a real, addressable conversation and must never be
 * captured as a session's bound `conversationUrl`.
 */
const REAL_CONVERSATION_URL = /\/c\/(?!WEB:)[^/?#]+/u;

/**
 * Navigate to the ChatGPT home/composer, ready for a brand-new conversation.
 * Direct navigation to `/` is used instead of clicking a "New chat" control:
 * observed real behavior is that the sidebar/topbar new-chat button can fail
 * to register a click (covered by an overlay, mid-render, or simply not the
 * element Playwright resolved) while leaving the page on the PRIOR
 * conversation with no visible error — the exact failure mode that let two
 * different sessions previously bind to the same `conversationUrl`. A direct
 * `goto('/')` has no such failure mode: it either lands on `/` or throws.
 * Does not itself wait for a `/c/<id>` URL: the real conversation id is only
 * assigned after the first message is sent (see {@link waitForNewConversationUrl}).
 */
async function startNewChat() {
  if (!page) throw new Error('Playwright not initialized');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await findVisible(page, ['#prompt-textarea', '[contenteditable="true"]'], 15000);
}

/**
 * Deterministically wait for the page to settle on a real (non-placeholder)
 * ChatGPT conversation URL after the first message of a brand-new
 * conversation has been sent.
 * @param p - the live Playwright page.
 * @param timeoutMs - positive finite deadline for the real URL to appear.
 * @returns the settled `/c/<id>` URL.
 * @throws {Error} when no real conversation URL appears before the deadline;
 *   the caller must not bind a session to any URL in that case.
 */
async function waitForNewConversationUrl(p: Page, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = p.url();
    if (REAL_CONVERSATION_URL.test(url)) return url;
    await sleep(150);
  }
  throw new Error(`GPTProxy did not observe a real ChatGPT conversation URL within ${timeoutMs}ms (last seen: ${p.url()})`);
}

/**
 * Every wait/click/fill below carries an explicit finite timeout so a
 * blocked or intercepted composer (an overlay, a rate-limit banner, a
 * payment prompt) surfaces as a bounded, catchable error instead of hanging
 * the request indefinitely.
 */
const COMPOSER_INTERACTION_TIMEOUT_MS = 30000;

async function sendPrompt(p: Page, text: string) {
  const composer = await findVisible(p, ['#prompt-textarea', '[contenteditable="true"]'], COMPOSER_INTERACTION_TIMEOUT_MS);
  if (!composer) throw new Error('ChatGPT composer not found');
  await composer.click({ timeout: COMPOSER_INTERACTION_TIMEOUT_MS });
  await composer.fill(text, { timeout: COMPOSER_INTERACTION_TIMEOUT_MS }).catch(async () => {
    await p.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await p.keyboard.type(text, { delay: 1 });
  });
  await sleep(200);

  const btn = await findVisible(p, [
    '[data-testid="send-button"]',
    '[data-testid="composer-send-button"]',
    'button[type="submit"]',
  ], 4000);
  if (btn) {
    await btn.click({ timeout: COMPOSER_INTERACTION_TIMEOUT_MS }).catch(async () => {
      await composer.press('Enter', { timeout: COMPOSER_INTERACTION_TIMEOUT_MS });
    });
  } else {
    await composer.press('Enter', { timeout: COMPOSER_INTERACTION_TIMEOUT_MS });
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
    await input.setInputFiles(paths, { timeout: 15000 });
    await sleep(1200);
  } finally {
    for (const fp of paths) fs.rmSync(fp, { force: true });
  }
}

async function readAssistantStream(
  p: Page,
  onDelta: ((delta: string) => Promise<void> | void) | undefined,
  timeoutMs: number
): Promise<string> {
  const msg = p.locator('[data-message-author-role="assistant"]').last();
  const legacyMsg = await msg.waitFor({ state: 'attached', timeout: 5000 }).then(() => true).catch(() => false);

  const contentLoc = msg.locator('.markdown').first();
  const readText = async (): Promise<string> => {
    try {
      if (legacyMsg) {
        const visible = await contentLoc.first().waitFor({ state: 'visible', timeout: 1000 }).catch(() => null);
        if (!visible) {
          const raw = await msg.innerText().catch(() => '');
          return raw;
        }
        return await contentLoc.first().innerText().catch(() => '');
      }
      return await p.evaluate(() => {
        const texts = Array.from(document.querySelectorAll('main p, main .markdown, main article, main [dir="auto"]'))
          .map((el) => (el as HTMLElement).innerText?.trim() || '')
          .filter(Boolean)
          .filter((text) => !text.startsWith('User:'));
        return texts.at(-1) || '';
      });
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

export interface AskChatGPTOptions {
  sessionKey?: string;
  hydrationPrompt?: string;
  hydrationKey?: string;
  requestId?: string;
  scenario?: string;
}

/**
 * Thrown when a session's first real conversation URL would collide with a
 * URL already bound to a DIFFERENT live session key. Binding proceeds only
 * when no other session currently owns that URL; the caller must not
 * silently continue on this error, since doing so would let two Harness
 * chats share one ChatGPT conversation and its accumulated context.
 */
export class SessionConversationCollisionError extends Error {
  readonly code = 'SESSION_CONVERSATION_COLLISION';
  constructor(readonly sessionKey: string, readonly conversationUrl: string, readonly ownedBy: string) {
    super(`GPTProxy session "${sessionKey}" resolved to conversation ${conversationUrl}, already bound to session "${ownedBy}"`);
  }
}

async function openSessionConversation(p: Page, session: GptProxySession | null): Promise<void> {
  if (!session) {
    await startNewChat();
    return;
  }
  if (session.conversationUrl) {
    await p.goto(session.conversationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return;
  }
  await startNewChat();
}

/**
 * Bind a session's first real conversation URL, after the first message of a
 * brand-new conversation was just sent. Deterministically waits past
 * ChatGPT's transient `/c/WEB:<uuid>` placeholder for the real, stable
 * `/c/<id>` URL, then rejects a collision with another live session before
 * committing the bind.
 * @param p - the live Playwright page, mid-generation on the new conversation.
 * @param session - the session whose first-ever conversation URL this is.
 * @param timeoutMs - deadline for the real URL to settle.
 * @throws {SessionConversationCollisionError} if the resolved URL already belongs to another session.
 * @throws {Error} if no real conversation URL settles before the deadline.
 */
async function bindNewConversationUrl(p: Page, session: GptProxySession, timeoutMs: number): Promise<void> {
  const url = await waitForNewConversationUrl(p, timeoutMs);
  const owner = gptProxySessions.ownerOf(url);
  if (owner !== undefined && owner !== session.key) {
    throw new SessionConversationCollisionError(session.key, url, owner);
  }
  gptProxySessions.markTurn(session, url);
}

async function hydrateSession(p: Page, session: GptProxySession, options: AskChatGPTOptions, timeoutMs: number): Promise<void> {
  if (!options.hydrationPrompt || !options.hydrationKey) return;
  if (session.hydrationKey === options.hydrationKey) return;
  const isFirstMessage = session.conversationUrl === undefined;
  await sendPrompt(p, options.hydrationPrompt);
  if (isFirstMessage) await bindNewConversationUrl(p, session, timeoutMs);
  await readAssistantStream(p, undefined, timeoutMs);
  session.hydrationKey = options.hydrationKey;
  gptProxySessions.markTurn(session, p.url());
}

export function listGptProxySessions() {
  return gptProxySessions.list();
}

export function clearGptProxySession(key: string): boolean {
  return gptProxySessions.clear(key);
}

export async function askChatGPT(
  prompt: string,
  onDelta?: (delta: string) => Promise<void> | void,
  timeoutMs = 300000,
  attachments: Attachment[] = [],
  options: AskChatGPTOptions = {}
): Promise<{ text: string }> {
  if (!page) throw new Error('Playwright not initialized');

  const requestId = options.requestId ?? (crypto as any).randomUUID();
  const startedAt = Date.now();
  const mark = (): number => Date.now();
  const release = await uiMutex.acquire();
  try {
    const beforeLogin = mark();
    if (!(await ensureLoggedIn())) {
      throw LOGIN_REQUIRED;
    }
    const loginCheckMs = mark() - beforeLogin;

    const beforeNav = mark();
    const session = options.sessionKey ? gptProxySessions.getOrCreate(options.sessionKey) : null;
    await openSessionConversation(page, session);
    const navigationMs = mark() - beforeNav;

    let hydrationMs: number | undefined;
    if (session) {
      const beforeHydration = mark();
      await hydrateSession(page, session, options, timeoutMs);
      hydrationMs = mark() - beforeHydration;
    }
    if (attachments.length) await attachFiles(page, attachments);

    // A session with no bound conversationUrl yet is about to send the first
    // real message of a brand-new ChatGPT conversation (hydration, if any,
    // already bound it above). This send must resolve and bind the real
    // conversation URL before any further turn on this session trusts it.
    const isFirstMessageOfSession = session !== null && session.conversationUrl === undefined;

    const beforeSend = mark();
    await sendPrompt(page, prompt);
    const sendPromptMs = mark() - beforeSend;

    if (isFirstMessageOfSession && session !== null) {
      await bindNewConversationUrl(page, session, timeoutMs);
    }

    let text = '';
    const beforeUiRoundTrip = mark();
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
    const uiRoundTripMs = mark() - beforeUiRoundTrip;

    // A settled session (one that already has a bound conversationUrl, from
    // this turn or an earlier one) is refreshed here; the collision check
    // already ran in bindNewConversationUrl for the first-message case above.
    if (session) gptProxySessions.markTurn(session, page.url());
    recordTurn({
      requestId,
      ...options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey },
      ...options.scenario === undefined ? {} : { scenario: options.scenario },
      startedAt,
      loginCheckMs,
      navigationMs,
      ...hydrationMs === undefined ? {} : { hydrationMs },
      sendPromptMs,
      uiRoundTripMs,
      totalMs: Date.now() - startedAt,
      success: true,
    });
    return { text };
  } catch (error) {
    recordTurn({
      requestId,
      ...options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey },
      ...options.scenario === undefined ? {} : { scenario: options.scenario },
      startedAt,
      totalMs: Date.now() - startedAt,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    release();
  }
}
