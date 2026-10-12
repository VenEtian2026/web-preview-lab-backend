const express = require('express');
const cors = require('cors');
const dns = require('node:dns').promises;
const net = require('node:net');
const { chromium } = require('playwright');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || 'https://venanciobautista.com,http://localhost:8080,http://127.0.0.1:8080')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT || 2));
const NAV_TIMEOUT = Math.max(5000, Number(process.env.NAV_TIMEOUT_MS || 20000));
let active = 0;
let browserPromise;

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] === 0;
  }
  const low = ip.toLowerCase();
  return low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb');
}

async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('URL inválida.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Solo se permiten URLs http/https.');
  if (url.username || url.password) throw new Error('No se permiten credenciales en la URL.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Host local bloqueado.');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error('La URL apunta a una red privada o no pública.');
  return url.href;
}

function viewport(value, fallback, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return browserPromise;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'web-preview-lab-api', active }));

app.post('/api/screenshot', async (req, res) => {
  if (active >= MAX_CONCURRENT) return res.status(429).json({ ok: false, error: 'El servidor está ocupado. Intenta de nuevo en unos segundos.' });
  active++;
  let context;
  try {
    const url = await validatePublicUrl(req.body?.url);
    const width = viewport(req.body?.width, 1440, 240, 2560);
    const height = viewport(req.body?.height, 900, 320, 2160);
    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    const page = await context.newPage();

    // Bloquea navegación/subrecursos que resuelvan a IP privada para reducir SSRF.
    await page.route('**/*', async route => {
      try {
        const requestUrl = new URL(route.request().url());
        if (!['http:', 'https:', 'data:', 'blob:'].includes(requestUrl.protocol)) return route.abort();
        if (['data:', 'blob:'].includes(requestUrl.protocol)) return route.continue();
        const records = await dns.lookup(requestUrl.hostname, { all: true, verbatim: true });
        if (records.some(r => isPrivateIp(r.address))) return route.abort();
        return route.continue();
      } catch { return route.abort(); }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1200);
    const buffer = await page.screenshot({ type: 'jpeg', quality: 82, fullPage: false, animations: 'disabled' });
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Viewport': `${width}x${height}` });
    res.send(buffer);
  } catch (err) {
    const message = String(err?.message || 'No fue posible generar la captura.').replace(/\n.*/s, '');
    const status = /URL|Host|red privada|credenciales/.test(message) ? 400 : 502;
    res.status(status).json({ ok: false, error: message });
  } finally {
    active--;
    if (context) await context.close().catch(() => {});
  }
});

app.use((err, _req, res, _next) => {
  if (String(err?.message).includes('Origin not allowed')) return res.status(403).json({ ok: false, error: 'Origen no autorizado por CORS.' });
  console.error(err);
  res.status(500).json({ ok: false, error: 'Error interno.' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Web Preview Lab API running on :${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try { if (browserPromise) (await browserPromise).close(); } catch {}
    process.exit(0);
  });
}
