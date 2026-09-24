import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { chatCompletions } from './routes/chat.ts';
import { loginUiToken, registerLoginUiRoutes } from './routes/login-ui.ts';
import { initPlaywright, closePlaywright, getLoginStatus, generateImage, getContext, LOGIN_REQUIRED, BrowserType, listGptProxySessions, clearGptProxySession } from './services/chatgpt.ts';
import { telemetryLogPath } from './services/telemetry.ts';
import { networkInterfaces } from 'os';
import { fileURLToPath } from 'url';

const app = new Hono();
app.use('*', cors());
registerLoginUiRoutes(app);

function getNetworkAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

app.get('/health', async (c) => {
  try {
    const login = await getLoginStatus();
    return c.json({ status: 'ok', loggedIn: login.loggedIn, url: login.url ?? null });
  } catch (e: any) {
    return c.json({ status: 'ok', loggedIn: false });
  }
});

app.get('/v1/health', async (c) => {
  const login = await getLoginStatus();
  return c.json({ status: login.loggedIn ? 'ok' : 'degraded', loggedIn: login.loggedIn, url: login.url ?? null });
});

app.get('/debug/sessions', (c) => c.json({ sessions: listGptProxySessions() }));

app.get('/debug/telemetry-path', (c) => c.json({ path: telemetryLogPath() }));

app.delete('/debug/sessions/:key', (c) => {
  const removed = clearGptProxySession(c.req.param('key'));
  return c.json({ removed });
});

app.get('/debug/conv', async (c) => {
  try {
    const { getPage } = await import('./services/chatgpt.ts');
    const p = getPage();
    if (!p) return c.json({ error: 'no page' });
    const msgs = await p.evaluate(() => {
      const out: any[] = [];
      document.querySelectorAll('[data-message-author-role]').forEach((el) => {
        out.push({ role: el.getAttribute('data-message-author-role'), text: (el as HTMLElement).innerText.slice(0, 300) });
      });
      return out.slice(-8);
    });
    return c.json({ url: p.url(), msgs });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/debug/dump', async (c) => {
  try {
    const { getPage } = await import('./services/chatgpt.ts');
    const p = getPage();
    if (!p) return c.json({ error: 'no page' });
    const report = await p.evaluate(() => {
      const allImgs = Array.from(document.querySelectorAll('img'))
        .map((el) => ({ src: (el as HTMLImageElement).src.slice(0, 200), alt: (el as HTMLImageElement).alt.slice(0, 60) }))
        .slice(-8);
      const bgImgs: string[] = [];
      document.querySelectorAll('*').forEach((el) => {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg.includes('url(') && (bg.includes('oaiusercontent') || bg.includes('dalle') || bg.includes('chatgpt.com') || bg.includes('data:') || bg.includes('blob:'))) {
          bgImgs.push(bg.slice(0, 200));
        }
      });
      const turns = Array.from(document.querySelectorAll('[data-message-author-role]')).map((el) => ({
        role: el.getAttribute('data-message-author-role'),
        html: el.outerHTML.slice(0, 1600),
      })).slice(-3);
      const svgs = Array.from(document.querySelectorAll('svg[data-icon="image"], button[aria-label*="image" i]')).map((el) => el.outerHTML.slice(0, 120));
      return {
        url: location.href,
        allImgs: allImgs.slice(-5),
        bgImgs: bgImgs.slice(-5),
        turns,
        svgs: svgs.slice(0, 3),
      };
    });
    return c.json(report);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/debug/dom', async (c) => {
  try {
    const { getPage } = await import('./services/chatgpt.ts');
    const p = getPage();
    if (!p) return c.json({ error: 'no page' });
    const report = await p.evaluate(() => {
      const q = (s: string) => document.querySelector(s) !== null;
      const bodies = Array.from(document.querySelectorAll('[data-message-author-role="assistant"] .markdown')).map((el) => (el as HTMLElement).innerText.slice(0, 200));
      return {
        url: location.href,
        hasNewChatBtn: q('[data-testid="new-chat-button"]'),
        hasPrompt: q('#prompt-textarea'),
        hasStop: q('[data-testid="stop-button"]'),
        hasComposerSend: q('[data-testid="composer-send-button"], [data-testid="send-button"]'),
        assistantMarkdown: bodies.slice(-3),
        images: Array.from(document.querySelectorAll('[data-message-author-role="assistant"] img')).map((el) => (el as HTMLImageElement).src.slice(0, 160)),
        toasts: Array.from(document.querySelectorAll('[role="alert"], .snackbar, [data-radix-toast-viewport] *')).map((el) => (el as HTMLElement).innerText.slice(0, 200)).slice(0, 5),
        buttons: Array.from(document.querySelectorAll('button, a')).map((el) => ({
          testid: el.getAttribute('data-testid'),
          aria: el.getAttribute('aria-label'),
          text: ((el as HTMLElement).innerText || '').slice(0, 40),
        })).filter((b) => b.testid || b.aria || b.text).slice(0, 40),
      };
    });
    return c.json(report);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/v1/chat/completions', chatCompletions);

app.post('/v1/images/generations', async (c) => {
  try {
    const body: any = await c.req.json();
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : null;
    if (!prompt) return c.json({ error: { message: 'prompt is required' } }, 400);
    const n = body.n ?? 1;
    if (n > 1) return c.json({ error: { message: 'The ChatGPT web proxy generates a single image per call (n=1).' } }, 400);

    const res = await generateImage(prompt);

    let data: any = { url: res.url };
    const ctx = getContext();
    if (ctx && /^https?:\/\//.test(res.url)) {
      try {
        const r = await ctx.request.get(res.url);
        if (r.status() === 200) {
          const buf = await r.body();
          data = { b64_json: buf.toString('base64'), url: res.url };
        }
      } catch { /* keep url-only fallback */ }
    }

    return c.json({ created: Math.floor(Date.now() / 1000), data: [data] });
  } catch (err: any) {
    if (err === LOGIN_REQUIRED || err?.message?.includes('Login required')) {
      return c.json({ error: { message: 'Login required. Run "bun run login".' } }, 401);
    }
    return c.json({ error: { message: err.message } }, 502);
  }
});

app.get('/v1/models', (c) =>
  c.json({
    object: 'list',
    data: [
      'gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'chatgpt-latest',
    ].map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'openai',
    })),
  })
);

function getBrowserType(): BrowserType {
  const arg = process.argv.find((a) => a.startsWith('--browser='));
  if (arg) return arg.split('=')[1] as BrowserType;
  if (process.env.BROWSER) return process.env.BROWSER as BrowserType;
  return 'chromium';
}

function isHeadless(): boolean {
  const hasHeadedFlag = process.argv.includes('--headed');
  return !hasHeadedFlag && process.env.HEADED !== '1' && process.env.GPT_PROXY_HEADED !== '1';
}

const isEntry = process.argv[1] === fileURLToPath(import.meta.url);

export { app };

if (isEntry) {
  initPlaywright(isHeadless(), getBrowserType())
    .then(() => {
      const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
      const networkIP = getNetworkAddress();
      console.log('\nChatGPT Proxy started!');
      console.log(`- Local:   http://localhost:${port}`);
      if (networkIP) console.log(`- Network: http://${networkIP}:${port}`);
      console.log(`\nGPTProxy login UI: http://localhost:${port}/login-ui?token=${loginUiToken}`);
      console.log('\nAvailable Routes:');
      for (const route of app.routes) {
        console.log(`- [${route.method}] ${route.path}`);
      }
      if (isHeadless()) {
        console.log('\nNote: Se nao estiver logado, roda "bun run login" primeiro.');
      }
      console.log('');
      serve({ fetch: app.fetch, port });
    })
    .catch((err: any) => {
      console.error('Failed to initialize playwright:', err);
      process.exit(1);
    });
}

process.on('SIGINT', async () => {
  await closePlaywright();
  process.exit(0);
});
