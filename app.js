const express = require('express');
const cors = require('cors');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || 'https://venanciobautista.com,http://localhost:8080,http://127.0.0.1:8080')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || 3));
const SESSION_TTL = Math.max(60000, Number(process.env.SESSION_TTL_MS || 300000));
const NAV_TIMEOUT = Math.max(5000, Number(process.env.NAV_TIMEOUT_MS || 25000));
const MAX_CONCURRENT_ACTIONS = Math.max(1, Number(process.env.MAX_CONCURRENT_ACTIONS || 3));

let browserPromise;
let activeActions = 0;
const sessions = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  exposedHeaders: ['X-Session-Id', 'X-Current-Url', 'X-Page-Title', 'X-Viewport']
}));

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] === 0;
  }
  const low = ip.toLowerCase();
  return low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb');
}

async function assertPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) throw new Error('Host local bloqueado.');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error('La URL apunta a una red privada o no pública.');
}

async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('URL inválida.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Solo se permiten URLs http/https.');
  if (url.username || url.password) throw new Error('No se permiten credenciales en la URL.');
  await assertPublicHost(url.hostname);
  return url.href;
}

function viewport(value, fallback, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  }
  return browserPromise;
}

async function attachSafeRouting(page) {
  await page.route('**/*', async route => {
    try {
      const u = new URL(route.request().url());
      if (['data:', 'blob:'].includes(u.protocol)) return route.continue();
      if (!['http:', 'https:'].includes(u.protocol)) return route.abort();
      await assertPublicHost(u.hostname);
      return route.continue();
    } catch {
      return route.abort();
    }
  });
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.context.close().catch(() => {});
}

async function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL) await closeSession(id);
  }
}
setInterval(cleanupSessions, 30000).unref();

async function ensureCapacity() {
  await cleanupSessions();
  if (sessions.size < MAX_SESSIONS) return;
  const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
  if (oldest) await closeSession(oldest[0]);
}

function getSession(req, res) {
  const s = sessions.get(req.params.id);
  if (!s) {
    res.status(404).json({ ok: false, error: 'La sesión interactiva expiró. Genera el sitio de nuevo.' });
    return null;
  }
  s.lastUsed = Date.now();
  return s;
}

async function pageMeta(page) {
  const [url, title] = await Promise.all([
    Promise.resolve(page.url()),
    page.title().catch(() => '')
  ]);
  return { url, title };
}

async function sendScreenshot(res, session, { fullPage = false } = {}) {
  const { page, width, height, id } = session;
  await page.waitForTimeout(180);
  const buffer = await page.screenshot({ type: 'jpeg', quality: fullPage ? 78 : 82, fullPage, animations: 'disabled' });
  const meta = await pageMeta(page);
  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-store',
    'X-Session-Id': id,
    'X-Current-Url': encodeURIComponent(meta.url || ''),
    'X-Page-Title': encodeURIComponent(meta.title || ''),
    'X-Viewport': `${width}x${height}`
  });
  res.send(buffer);
}

async function withActionSlot(res, fn) {
  if (activeActions >= MAX_CONCURRENT_ACTIONS) {
    return res.status(429).json({ ok: false, error: 'El servidor está ocupado. Intenta de nuevo en unos segundos.' });
  }
  activeActions++;
  try { return await fn(); }
  finally { activeActions--; }
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'responsive-qa-lab-api', sessions: sessions.size, activeActions }));

app.post('/api/session', async (req, res) => withActionSlot(res, async () => {
  let context;
  try {
    const url = await validatePublicUrl(req.body?.url);
    const width = viewport(req.body?.width, 1440, 240, 2560);
    const height = viewport(req.body?.height, 900, 320, 2160);
    await ensureCapacity();
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await attachSafeRouting(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(900);
    const id = crypto.randomUUID();
    const session = { id, context, page, width, height, lastUsed: Date.now() };
    sessions.set(id, session);
    context = null;
    return sendScreenshot(res, session);
  } catch (err) {
    if (context) await context.close().catch(() => {});
    const message = String(err?.message || 'No fue posible abrir el sitio.').replace(/\n.*/s, '');
    const status = /URL|Host|red privada|credenciales/.test(message) ? 400 : 502;
    return res.status(status).json({ ok: false, error: message });
  }
}));

app.post('/api/session/:id/action', async (req, res) => withActionSlot(res, async () => {
  const s = getSession(req, res);
  if (!s) return;
  const { page } = s;
  try {
    const type = String(req.body?.type || '');
    if (type === 'click') {
      const x = Math.max(0, Math.min(s.width - 1, Number(req.body?.x) || 0));
      const y = Math.max(0, Math.min(s.height - 1, Number(req.body?.y) || 0));
      await page.mouse.click(x, y);
      await page.waitForTimeout(450);
    } else if (type === 'scroll') {
      const dx = Math.max(-2400, Math.min(2400, Number(req.body?.dx) || 0));
      const dy = Math.max(-4000, Math.min(4000, Number(req.body?.dy) || 0));
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(220);
    } else if (type === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null);
    } else if (type === 'forward') {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => null);
    } else if (type === 'reload') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } else if (type === 'resize') {
      const width = viewport(req.body?.width, s.width, 240, 2560);
      const height = viewport(req.body?.height, s.height, 320, 2160);
      await page.setViewportSize({ width, height });
      s.width = width; s.height = height;
      await page.waitForTimeout(300);
    } else if (type === 'type') {
      const text = String(req.body?.text || '').slice(0, 500);
      if (text) await page.keyboard.type(text, { delay: 20 });
    } else if (type === 'press') {
      const allowed = new Set(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace']);
      const key = String(req.body?.key || '');
      if (!allowed.has(key)) return res.status(400).json({ ok: false, error: 'Tecla no permitida.' });
      await page.keyboard.press(key);
      await page.waitForTimeout(180);
    } else {
      return res.status(400).json({ ok: false, error: 'Acción no válida.' });
    }
    s.lastUsed = Date.now();
    return sendScreenshot(res, s);
  } catch (err) {
    const message = String(err?.message || 'No se pudo ejecutar la interacción.').replace(/\n.*/s, '');
    return res.status(502).json({ ok: false, error: message });
  }
}));

app.post('/api/session/:id/fullpage', async (req, res) => withActionSlot(res, async () => {
  const s = getSession(req, res);
  if (!s) return;
  try { return sendScreenshot(res, s, { fullPage: true }); }
  catch (err) { return res.status(502).json({ ok: false, error: 'No se pudo generar la captura completa.' }); }
}));

app.get('/api/session/:id/audit', async (req, res) => withActionSlot(res, async () => {
  const s = getSession(req, res);
  if (!s) return;
  try {
    const audit = await s.page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const root = document.documentElement;
      const body = document.body;
      const overflowX = Math.max(root?.scrollWidth || 0, body?.scrollWidth || 0) > vw + 2;
      const visible = el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || 1) > 0;
      };
      const textEls = [...document.querySelectorAll('body *')].filter(el => visible(el) && el.childElementCount === 0 && (el.textContent || '').trim().length > 0).slice(0, 2500);
      let tinyText = 0;
      for (const el of textEls) if (parseFloat(getComputedStyle(el).fontSize) < 12) tinyText++;
      const interactive = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[onclick]')].filter(visible).slice(0, 1500);
      let smallTargets = 0;
      let offscreenTargets = 0;
      for (const el of interactive) {
        const r = el.getBoundingClientRect();
        if (r.width < 44 || r.height < 44) smallTargets++;
        if (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) offscreenTargets++;
      }
      const imgs = [...document.images].filter(visible).slice(0, 1000);
      let brokenImages = 0;
      let overflowingImages = 0;
      for (const img of imgs) {
        if (!img.complete || img.naturalWidth === 0) brokenImages++;
        const r = img.getBoundingClientRect();
        if (r.right > vw + 2 || r.left < -2) overflowingImages++;
      }
      const metaViewport = Boolean(document.querySelector('meta[name="viewport"]'));
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).length;
      const forms = [...document.forms].filter(visible).length;
      return {
        viewport: `${vw}×${vh}`,
        url: location.href,
        title: document.title,
        metrics: {
          overflowX,
          tinyText,
          smallTargets,
          offscreenTargets,
          brokenImages,
          overflowingImages,
          metaViewport,
          interactiveCount: interactive.length,
          imageCount: imgs.length,
          headingCount: headings,
          formCount: forms
        }
      };
    });
    const m = audit.metrics;
    let score = 100;
    if (m.overflowX) score -= 24;
    score -= Math.min(20, m.smallTargets * 2);
    score -= Math.min(16, m.tinyText * 2);
    score -= Math.min(16, m.brokenImages * 4);
    score -= Math.min(12, m.overflowingImages * 3);
    if (!m.metaViewport) score -= 12;
    audit.score = Math.max(0, score);
    audit.ok = true;
    return res.json(audit);
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'No fue posible ejecutar el análisis QA.' });
  }
}));

app.delete('/api/session/:id', async (req, res) => {
  await closeSession(req.params.id);
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  if (String(err?.message).includes('Origin not allowed')) return res.status(403).json({ ok: false, error: 'Origen no autorizado por CORS.' });
  console.error(err);
  res.status(500).json({ ok: false, error: 'Error interno.' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Responsive QA Lab API running on :${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try {
      for (const id of [...sessions.keys()]) await closeSession(id);
      if (browserPromise) (await browserPromise).close();
    } catch {}
    process.exit(0);
  });
}
