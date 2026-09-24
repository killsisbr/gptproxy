import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { closePlaywright, getLoginStatus, getPage, initPlaywright, saveStorageState } from '../services/chatgpt.ts';

const TOKEN_PATH = path.resolve('./.login-ui-token');

function readOrCreateToken(): string {
  if (process.env.GPTPROXY_LOGIN_TOKEN) return process.env.GPTPROXY_LOGIN_TOKEN;
  if (fs.existsSync(TOKEN_PATH)) return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  const token = randomUUID();
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}

export const loginUiToken = readOrCreateToken();

function authorized(c: any): boolean {
  const header = c.req.header('x-login-token');
  const query = c.req.query('token');
  return header === loginUiToken || query === loginUiToken;
}

function reject() {
  return new Response('unauthorized', { status: 401 });
}

async function ensurePage() {
  if (!getPage()) await initPlaywright(true, 'chromium');
  const p = getPage();
  if (!p) throw new Error('Playwright page is not available');
  return p;
}

function loginUiHtml(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GPTProxy Login</title>
<style>
  body{margin:0;background:#0f1115;color:#f4f4f5;font-family:Inter,system-ui,Arial,sans-serif}
  header{display:flex;gap:10px;align-items:center;padding:10px 14px;background:#181b22;border-bottom:1px solid #2b303b;position:sticky;top:0;z-index:2;flex-wrap:wrap}
  button,input{background:#242936;color:#fff;border:1px solid #3a4150;border-radius:8px;padding:8px 10px;font-size:14px}
  button{cursor:pointer} button:hover{background:#303747}.ok{color:#22c55e}.bad{color:#ef4444}.muted{color:#a1a1aa}
  main{padding:12px}.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.bar input{min-width:260px;flex:1}
  #shot{max-width:100%;height:auto;border:1px solid #333b49;border-radius:10px;background:#fff;cursor:crosshair}.log{white-space:pre-wrap;font-size:12px;color:#cbd5e1;margin-top:8px}
</style>
</head>
<body>
<header>
  <strong>GPTProxy Login</strong>
  <span id="status" class="muted">carregando...</span>
  <button onclick="start()">Abrir ChatGPT</button>
  <button onclick="refresh()">Atualizar imagem</button>
  <button onclick="save()">Salvar sessão</button>
  <button onclick="restart()">Reiniciar browser</button>
</header>
<main>
  <div class="bar">
    <input id="text" placeholder="Texto para digitar no campo selecionado" />
    <button onclick="typeText()">Digitar</button>
    <button onclick="press('Enter')">Enter</button>
    <button onclick="press('Tab')">Tab</button>
    <button onclick="press('Escape')">Esc</button>
    <button onclick="press('Backspace')">Backspace</button>
  </div>
  <img id="shot" alt="ChatGPT login page screenshot" onclick="clickShot(event)" />
  <div id="log" class="log"></div>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const headers = {'content-type':'application/json','x-login-token':token};
function log(msg){document.getElementById('log').textContent = new Date().toLocaleTimeString()+': '+msg+'\n'+document.getElementById('log').textContent.slice(0,3000)}
async function api(path, body){const r=await fetch(path,{method:'POST',headers,body:JSON.stringify(body||{})}); const t=await r.text(); let j; try{j=JSON.parse(t)}catch{j={text:t}} if(!r.ok) throw new Error(j.error||t); return j}
async function status(){const r=await fetch('/debug/login/status?token='+encodeURIComponent(token)); const j=await r.json(); const el=document.getElementById('status'); el.textContent=(j.loggedIn?'logado':'não logado')+' · '+(j.url||'sem página'); el.className=j.loggedIn?'ok':'bad'}
async function refresh(){document.getElementById('shot').src='/debug/login/screenshot?token='+encodeURIComponent(token)+'&t='+Date.now(); await status()}
async function start(){try{await api('/debug/login/start'); log('ChatGPT aberto'); await refresh()}catch(e){log('erro: '+e.message)}}
async function save(){try{const j=await api('/debug/login/save'); log('sessão salva: loggedIn='+j.loggedIn); await status()}catch(e){log('erro: '+e.message)}}
async function restart(){try{await api('/debug/login/restart'); log('browser reiniciado'); await refresh()}catch(e){log('erro: '+e.message)}}
async function typeText(){const v=document.getElementById('text').value; try{await api('/debug/login/type',{text:v}); document.getElementById('text').value=''; await refresh()}catch(e){log('erro: '+e.message)}}
async function press(key){try{await api('/debug/login/press',{key}); await refresh()}catch(e){log('erro: '+e.message)}}
async function clickShot(ev){const img=ev.currentTarget; const r=img.getBoundingClientRect(); const x=(ev.clientX-r.left)*img.naturalWidth/r.width; const y=(ev.clientY-r.top)*img.naturalHeight/r.height; try{await api('/debug/login/click',{x,y}); await new Promise(r=>setTimeout(r,700)); await refresh()}catch(e){log('erro: '+e.message)}}
start(); setInterval(status,5000);
</script>
</body>
</html>`;
}

export function registerLoginUiRoutes(app: Hono): void {
  app.get('/login-ui', (c) => {
    if (!authorized(c)) return reject();
    return c.html(loginUiHtml());
  });

  app.get('/debug/login/status', async (c) => {
    if (!authorized(c)) return reject();
    const login = await getLoginStatus();
    return c.json({ loggedIn: login.loggedIn, url: login.url ?? null });
  });

  app.post('/debug/login/start', async (c) => {
    if (!authorized(c)) return reject();
    const p = await ensurePage();
    await p.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const login = await getLoginStatus();
    return c.json({ ok: true, loggedIn: login.loggedIn, url: login.url ?? null });
  });

  app.get('/debug/login/screenshot', async (c) => {
    if (!authorized(c)) return reject();
    const p = await ensurePage();
    const png = await p.screenshot({ fullPage: false, type: 'png' });
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  });

  app.post('/debug/login/click', async (c) => {
    if (!authorized(c)) return reject();
    const body = await c.req.json().catch(() => ({}));
    const x = Number(body.x);
    const y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return c.json({ error: 'x and y are required numbers' }, 400);
    const p = await ensurePage();
    await p.mouse.click(x, y);
    return c.json({ ok: true, url: p.url() });
  });

  app.post('/debug/login/type', async (c) => {
    if (!authorized(c)) return reject();
    const body = await c.req.json().catch(() => ({}));
    const text = String(body.text ?? '');
    const p = await ensurePage();
    await p.keyboard.type(text, { delay: 20 });
    return c.json({ ok: true, url: p.url() });
  });

  app.post('/debug/login/press', async (c) => {
    if (!authorized(c)) return reject();
    const body = await c.req.json().catch(() => ({}));
    const key = String(body.key ?? '');
    if (!key) return c.json({ error: 'key is required' }, 400);
    const p = await ensurePage();
    await p.keyboard.press(key);
    return c.json({ ok: true, url: p.url() });
  });

  app.post('/debug/login/save', async (c) => {
    if (!authorized(c)) return reject();
    await saveStorageState();
    const login = await getLoginStatus();
    return c.json({ ok: true, loggedIn: login.loggedIn, url: login.url ?? null });
  });

  app.post('/debug/login/restart', async (c) => {
    if (!authorized(c)) return reject();
    await closePlaywright();
    await initPlaywright(true, 'chromium');
    const login = await getLoginStatus();
    return c.json({ ok: true, loggedIn: login.loggedIn, url: login.url ?? null });
  });
}
