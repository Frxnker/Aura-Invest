/**
 * Comprobación de Aura Invest en un navegador real (Edge o Chrome) por CDP.
 *
 *   node tools/browser-check.mjs            sin clave de API: 0 créditos
 *   node tools/browser-check.mjs --demo     además, con la clave pública «demo» de Twelve Data
 *                                           (solo AAPL y EUR/USD; no gasta créditos de nadie)
 *
 * Opciones: --browser=<ruta del ejecutable>  --headed (ver la ventana)  --keep (no borrar el perfil)
 *           --out=<carpeta para las capturas> (por defecto, una carpeta temporal)
 *
 * Requisitos: Node 22 o posterior (WebSocket nativo) y Edge o Chrome instalados. Sin dependencias.
 * No forma parte de `node --test`: abre un navegador de verdad y, con --demo, usa la red.
 * Usa un perfil temporal propio (nunca el tuyo), cierra el navegador con Browser.close (un `kill`
 * puede perder lo último escrito en localStorage) y borra el perfil al terminar.
 * Sale con código 0 si todo pasa, 1 si algo falla y 2 si no puede empezar.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));

if (args.help) {
  console.log('Uso: node tools/browser-check.mjs [--demo] [--headed] [--keep] [--browser=<ruta>] [--out=<carpeta>]');
  process.exit(0);
}
if (typeof WebSocket !== 'function') {
  console.error('Hace falta Node 22 o posterior (WebSocket nativo).');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
 * Navegador, servidor y perfil
 * ------------------------------------------------------------------------- */

function findBrowser() {
  if (typeof args.browser === 'string') return args.browser;
  const env = process.env;
  const candidates = {
    win32: [
      `${env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    darwin: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] || [];
  return candidates.find((p) => p && existsSync(p)) || null;
}

const freePort = () => new Promise((ok, ko) => {
  const s = net.createServer();
  s.unref();
  s.on('error', ko);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

/** Arranca tools/serve.mjs en un puerto libre y espera a que escuche. */
async function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, ko) => {
    const t = setTimeout(() => ko(new Error('El servidor no arranca.')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); ok(); } });
    child.on('exit', (code) => { clearTimeout(t); ko(new Error(`El servidor se ha cerrado (código ${code}).`)); });
  });
  return child;
}

async function launchBrowser(exe, cdpPort, profile) {
  const flags = [
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    // Sin frenos por ventana tapada o en segundo plano: si no, las cargas parecen colgarse
    '--disable-features=CalculateNativeWinOcclusion,Translate',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--window-size=1440,900',
    ...(args.headed ? [] : ['--headless=new']),
    'about:blank',
  ];
  const child = spawn(exe, flags, { stdio: 'ignore', detached: false });
  for (let i = 0; i < 80; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
      if (v.webSocketDebuggerUrl) return { child, version: v };
    } catch { /* aún no escucha */ }
    await sleep(250);
  }
  throw new Error('El navegador no abre el puerto de depuración.');
}

/* ---------------------------------------------------------------------------
 * Cliente CDP mínimo
 * ------------------------------------------------------------------------- */

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error('No se puede conectar por CDP.')); });
  let id = 0;
  const pending = new Map();
  const handlers = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, ko } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) ko(new Error(msg.error.message)); else ok(msg.result);
    } else handlers.forEach((h) => h(msg));
  };
  return {
    send: (method, params = {}) => new Promise((ok, ko) => { pending.set(++id, { ok, ko }); ws.send(JSON.stringify({ id, method, params })); }),
    on: (h) => handlers.add(h),
    close: () => ws.close(),
  };
}

/* ---------------------------------------------------------------------------
 * Ayudas sobre la página
 * ------------------------------------------------------------------------- */

const KEYS = { Enter: [13, '\r'], Tab: [9, ''], Escape: [27, ''], ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''], Delete: [46, ''] };

function pageTools(c, outDir) {
  const ev = async (expression) => {
    const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const t = {
    ev,
    async waitFor(expr, ms = 20000, what = expr) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await ev(expr).catch(() => false)) return;
        await sleep(200);
      }
      throw new Error(`no ocurre en ${ms / 1000} s: ${what}`);
    },
    async key(name, { shift = false } = {}) {
      const [code, text] = KEYS[name];
      const base = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
      await c.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(60);
    },
    /** id del elemento con el foco (o su etiqueta si no tiene id). */
    active: () => ev(`(() => { const a = document.activeElement; return a ? (a.id || a.tagName.toLowerCase()) : null; })()`),
    /** Tab hasta el elemento con ese id (como mucho `max` pulsaciones). */
    async tabTo(id, max = 60) {
      for (let i = 0; i < max; i++) {
        if ((await t.active()) === id) return i;
        await t.key('Tab');
      }
      throw new Error(`el teclado no llega a #${id}`);
    },
    async viewport(width, height, mobile = false) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
      await sleep(400);
    },
    /** Posición en pantalla de un elemento (por defecto lo centra antes). */
    rect: (sel, { scroll = true } = {}) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; if (${scroll}) e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`),
    async click(x, y) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
      await sleep(250);
    },
    async touch(type, x, y) {
      const points = type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
      await c.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    },
    async tap(x, y) { await t.touch('touchStart', x, y); await sleep(60); await t.touch('touchEnd'); await sleep(300); },
    async drag(x1, y1, x2, y2, { end = 'touchEnd', steps = 8 } = {}) {
      await t.touch('touchStart', x1, y1); await sleep(60);
      for (let i = 1; i <= steps; i++) { await t.touch('touchMove', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps); await sleep(30); }
      await t.touch(end); await sleep(350);
    },
    async shot(name) {
      const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    },
  };
  return t;
}

/* ---------------------------------------------------------------------------
 * Comprobaciones
 * ------------------------------------------------------------------------- */

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail || '' });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ ok: false, name, detail: err.message });
    console.log(`  ✘ ${name} — ${err.message}`);
  }
  if (Date.now() - t0 > 30000) console.log(`    (${Math.round((Date.now() - t0) / 1000)} s)`);
}

/** Abre un diálogo con Intro desde su botón, comprueba el foco y lo cierra con Escape. */
async function dialogByKeyboard(t, opener, dialog, focusInside) {
  await t.ev(`document.querySelector('#${opener}').focus()`);
  await t.key('Enter');
  await t.waitFor(`document.querySelector('#${dialog}').open`, 5000, `se abre #${dialog}`);
  const inside = await t.ev(`document.querySelector('#${dialog}').contains(document.activeElement)`);
  const focusId = await t.active();
  if (!inside) throw new Error(`el foco no entra en el diálogo (está en ${focusId})`);
  if (focusInside && focusId !== focusInside) throw new Error(`el foco va a #${focusId} y se esperaba #${focusInside}`);
  await t.key('Escape');
  await t.waitFor(`!document.querySelector('#${dialog}').open`, 3000, `se cierra #${dialog} con Escape`);
  const back = await t.active();
  if (back !== opener) throw new Error(`al cerrar, el foco vuelve a ${back} y no a #${opener}`);
  return `foco en ${focusId}; Escape lo cierra y el foco vuelve a #${opener}`;
}

const ACCESSIBLE_NAMES = `(() => {
  const name = (e) => {
    const by = e.getAttribute('aria-labelledby');
    if (by) return by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
    if (e.getAttribute('aria-label')) return e.getAttribute('aria-label').trim();
    if (e.labels && e.labels.length) return [...e.labels].map((l) => l.textContent).join(' ').trim();
    return (e.textContent || '').trim() || (e.getAttribute('title') || '').trim();
  };
  const els = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=button]')]
    .filter((e) => !(e.type === 'file' && e.hidden));
  return { total: els.length, missing: els.filter((e) => !name(e)).map((e) => e.outerHTML.slice(0, 90)) };
})()`;

async function main() {
  const exe = findBrowser();
  if (!exe) { console.error('No encuentro Edge ni Chrome. Indica la ruta con --browser=<ruta>.'); process.exit(2); }
  const outDir = typeof args.out === 'string' ? path.resolve(args.out) : mkdtempSync(path.join(tmpdir(), 'aura-check-shots-'));
  mkdirSync(outDir, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), 'aura-check-profile-'));
  const [webPort, cdpPort] = [await freePort(), await freePort()];
  const appUrl = `http://localhost:${webPort}/`;

  console.log(`Navegador: ${exe}\nApp: ${appUrl} · perfil temporal: ${profile}\nCapturas: ${outDir}\n`);
  const server = await startServer(webPort);
  const { child: browser, version } = await launchBrowser(exe, cdpPort, profile);
  console.log(`${version.Browser}${args.headed ? '' : ' (sin ventana)'}\n`);

  const problems = [];
  let b = null, c = null;
  try {
    b = await connect(version.webSocketDebuggerUrl);
    const target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page');
    c = await connect(target.webSocketDebuggerUrl);
    c.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') problems.push(`excepción: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) problems.push(`error del navegador: ${m.params.entry.text}`);
    });
    await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Page.enable');
    const t = pageTools(c, outDir);
    await t.viewport(1440, 900);

    console.log('Sin clave de API (0 créditos)');
    await check('La app carga y pide la clave', async () => {
      await c.send('Page.navigate', { url: appUrl });
      await t.waitFor(`!!(window.Aura && Aura.state && !document.querySelector('#emptyState').hidden)`, 20000, 'estado vacío visible');
      const txt = await t.ev(`document.querySelector('#emptyState').innerText.split(String.fromCharCode(10))[0]`);
      await t.shot('1440-sin-clave');
      return `«${txt}»`;
    });
    await check('Ajustes con teclado', () => dialogByKeyboard(t, 'settingsBtn', 'settingsDialog', 'apiKeyInput'));
    await check('Alertas con teclado', () => dialogByKeyboard(t, 'alertsBtn', 'alertsDialog'));
    await check('Editar la watchlist con teclado', () => dialogByKeyboard(t, 'wlEdit', 'watchlistDialog'));
    await check('Pestañas Mercado/Cartera con flechas', async () => {
      await t.ev(`document.querySelector('#tabMarket').focus()`);
      await t.key('ArrowRight');
      await t.waitFor(`document.activeElement.id === 'tabPortfolio' && !document.querySelector('#viewPortfolio').hidden`, 3000, 'Cartera visible');
      await t.key('ArrowLeft');
      await t.waitFor(`document.activeElement.id === 'tabMarket' && !document.querySelector('#viewMarket').hidden`, 3000, 'Mercado visible');
      return '→ Cartera, ← Mercado';
    });
    await check('Todos los controles tienen nombre accesible', async () => {
      const r = await t.ev(ACCESSIBLE_NAMES);
      if (r.missing.length) throw new Error(`${r.missing.length} sin nombre: ${r.missing.slice(0, 3).join(' · ')}`);
      return `${r.total} controles`;
    });
    for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]]) {
      await check(`Sin desplazamiento horizontal a ${w} px (Mercado y Cartera)`, async () => {
        await t.viewport(w, h, w < 600);
        const out = [];
        for (const view of ['Market', 'Portfolio']) {
          await t.ev(`document.querySelector('#tab${view}').click()`);
          await sleep(300);
          const r = await t.ev(`({ sw: document.documentElement.scrollWidth, iw: innerWidth })`);
          if (r.sw > r.iw + 1) throw new Error(`${view === 'Market' ? 'Mercado' : 'Cartera'}: ancho ${r.sw} px > ${r.iw} px`);
          out.push(r.sw);
          if (w === 390) await t.shot(`390-${view === 'Market' ? 'mercado' : 'cartera'}-sin-clave`);
        }
        await t.ev(`document.querySelector('#tabMarket').click()`);
        return `ancho ${out.join(' / ')} px`;
      });
    }
    await t.viewport(1440, 900);

    if (args.demo) {
      console.log('\nCon la clave pública «demo» de Twelve Data (AAPL y EUR/USD)');
      await check('Con la clave demo carga AAPL', async () => {
        // La clave demo solo sirve para AAPL y EUR/USD: se deja la watchlist del perfil temporal con esos dos.
        // Ajustes exige claves de 8 o más caracteres, así que «demo» se guarda con la API de la app.
        await t.ev(`Aura.watchlist.ids().filter((id) => !['AAPL', 'EUR/USD'].includes(id)).forEach((id) => Aura.watchlist.remove(id)); Aura.store.setApiKey('demo')`);
        await c.send('Page.navigate', { url: `${appUrl}?demo=1#t=AAPL&tf=6M` });          // otra URL: recarga de verdad
        await sleep(1000);
        await t.waitFor(`window.Aura && Aura.state.model && Aura.state.model.meta.id === 'AAPL' && !document.body.classList.contains('is-loading')`, 60000, 'modelo de AAPL cargado');
        await sleep(800);
        await t.shot('1440-aapl');
        return `${await t.ev('Aura.state.model.bars.length')} velas diarias`;
      });
      await check('Panel «Análisis del modelo» completo y en español', async () => {
        const r = await t.ev(`({ action: document.querySelector('#reco').dataset.action, reco: document.querySelector('#recoText').textContent,
          cone: Number.isFinite(Aura.state.model.fc.end.upper), rationale: document.querySelectorAll('#rationale li').length,
          english: [...document.querySelectorAll('#aiPanel *')].filter((e) => !e.children.length && /^(Bullish|Bearish|Entry|Price Target|Stop Loss|Potential Upside|High|Medium|Low)$/.test(e.textContent.trim())).map((e) => e.textContent.trim()) })`);
        if (!['buy', 'hold', 'sell'].includes(r.action)) throw new Error('sin señal');
        if (!r.cone) throw new Error('sin cono');
        if (r.rationale < 3) throw new Error('faltan frases del análisis');
        if (r.english.length) throw new Error(`textos en inglés: ${r.english.join(', ')}`);
        return `señal ${r.reco}, ${r.rationale} frases`;
      });
      await check('Barra del gráfico en una fila y desplegables con teclado', async () => {
        const h = await t.ev(`Math.round(document.querySelector('.toolbar').getBoundingClientRect().height)`);
        if (h > 60) throw new Error(`la barra mide ${h} px de alto a 1440 px (más de una fila)`);
        await t.ev(`document.querySelector('#indMenuBtn').focus()`);
        await t.key('Enter');
        await t.waitFor(`document.querySelector('#indMenuBtn').getAttribute('aria-expanded') === 'true' && !document.querySelector('#indMenu').hidden`, 2000, 'se abre «Indicadores»');
        const count0 = await t.ev(`document.querySelector('#indCount').textContent`);
        await t.key('Tab');
        const first = await t.ev(`document.activeElement.dataset.toggle`);
        await t.key('Enter');
        const after = await t.ev(`({ pressed: document.querySelector('[data-toggle="ema"]').getAttribute('aria-pressed'), count: document.querySelector('#indCount').textContent, open: !document.querySelector('#indMenu').hidden })`);
        await t.key('Enter');                                                         // la vuelve a encender
        await t.key('Escape');
        await t.waitFor(`document.querySelector('#indMenu').hidden && document.activeElement.id === 'indMenuBtn' && document.querySelector('#indMenuBtn').getAttribute('aria-expanded') === 'false'`, 2000, 'Escape cierra y devuelve el foco');
        if (first !== 'ema' || after.pressed !== 'false' || after.count === count0 || !after.open) throw new Error(`EMA ${after.pressed}, contador ${count0} → ${after.count}, abierto ${after.open}`);
        return `${h} px de alto; Indicadores ${count0} → ${after.count} al apagar EMA 20; Escape cierra`;
      });
      await check('Dibujo con ratón y teclado: crear, mover con ↑ y borrar con Supr', async () => {
        await t.ev(`Aura.drawings.clear(Aura.state.symbol)`);
        await t.ev(`document.querySelector('#drawMenuBtn').focus()`);
        await t.key('Enter');
        await t.ev(`document.querySelector('[data-draw="hline"]').focus()`);
        await t.key('Enter');
        const back = await t.active();
        if (back !== 'drawMenuBtn') throw new Error(`al elegir la herramienta, el foco va a ${back}`);
        const p = await t.rect('#chartMain');
        await t.click(p.x + p.w * 0.4, p.y + p.h * 0.45);
        const p1 = await t.ev(`Aura.drawings.list(Aura.state.symbol).map((d) => d.price)`);
        if (p1.length !== 1) throw new Error('no se crea la línea');
        await t.ev(`document.body.focus()`);
        await t.key('ArrowUp');
        const p2 = await t.ev(`Aura.drawings.list(Aura.state.symbol)[0].price`);
        if (!(p2 > p1[0])) throw new Error('↑ no la mueve');
        await t.key('Delete');
        if ((await t.ev(`Aura.drawings.list(Aura.state.symbol).length`)) !== 0) throw new Error('Supr no la borra');
        return `${p1[0].toFixed(2)} → ${p2.toFixed(2)} → borrada`;
      });
      await check('Dibujo con el dedo a 390 px: crear, arrastrar, gesto cancelado y borrar', async () => {
        await t.viewport(390, 844, true);
        await t.ev(`Aura.drawings.clear(Aura.state.symbol); Aura.drawingTools.reset()`);
        let r = await t.rect('#drawMenuBtn');
        await t.tap(r.cx, r.cy);
        r = await t.rect('[data-draw="hline"]', { scroll: false });
        await t.tap(r.cx, r.cy);
        let p = await t.rect('#chartMain');
        await t.tap(p.x + p.w * 0.4, p.y + p.h * 0.45);
        const n = await t.ev(`Aura.drawings.list(Aura.state.symbol).length`);
        if (n !== 1) throw new Error('no se crea la línea con un toque');
        const before = await t.ev(`Aura.drawings.list(Aura.state.symbol)[0].price`);
        p = await t.rect('#chartMain', { scroll: false });                           // la pista sobre el gráfico puede haberlo movido
        let y = p.y + (await t.ev(`Aura.charts.drawingApi().primitive.coords[0].y`));
        await t.ev(`window.__pe = []; for (const k of ['pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(k, (e) => __pe.push(k.slice(7) + ':' + Math.round(e.clientY)), true)`);
        await t.drag(p.x + p.w / 2, y + 12, p.x + p.w / 2, y - 38);                // dedo 12 px por debajo
        const after = await t.ev(`Aura.drawings.list(Aura.state.symbol)[0].price`);
        if (!(after > before)) {
          const d = await t.ev(`({ pe: __pe.join(' '), lineY: Math.round(document.querySelector('#chartMain').getBoundingClientRect().y + Aura.charts.drawingApi().primitive.coords[0].y) })`);
          throw new Error(`con 12 px de error no se agarra la línea (dedo en y=${Math.round(y + 12)}, línea en y=${d.lineY}; eventos: ${d.pe})`);
        }
        p = await t.rect('#chartMain', { scroll: false });
        y = p.y + (await t.ev(`Aura.charts.drawingApi().primitive.coords[0].y`));
        await t.drag(p.x + p.w / 2, y, p.x + p.w / 2, y - 30, { end: 'touchCancel', steps: 3 });
        const locked = await t.ev(`!Aura.charts.drawingApi().chart.options().handleScroll.pressedMouseMove`);
        const kept = await t.ev(`Aura.drawings.list(Aura.state.symbol)[0].price`);
        if (locked) throw new Error('tras cancelar el gesto, el gráfico queda bloqueado');
        if (kept !== after) throw new Error('el gesto cancelado ha cambiado la línea');
        r = await t.rect('#drawMenuBtn');
        await t.tap(r.cx, r.cy);
        r = await t.rect('#drawListBtn', { scroll: false });
        await t.tap(r.cx, r.cy);
        await t.waitFor(`document.querySelector('#drawDialog').open`, 3000, 'diálogo «Dibujos»');
        r = await t.rect('#drawItems button[data-act="remove"]');
        await t.tap(r.cx, r.cy);
        if ((await t.ev(`Aura.drawings.list(Aura.state.symbol).length`)) !== 0) throw new Error('no se borra desde «Dibujos»');
        r = await t.rect('#drawDialog [data-close]');
        await t.tap(r.cx, r.cy);
        await t.shot('390-dibujo');
        await t.viewport(1440, 900);
        return `${before.toFixed(2)} → ${after.toFixed(2)}; cancelado sin efecto; borrada`;
      });
      await check('Con el dedo, el gráfico se desplaza en horizontal y la página no', async () => {
        await t.viewport(390, 844, true);
        const p = await t.rect('#chartMain');
        const before = await t.ev(`({ range: Aura.charts.drawingApi().chart.timeScale().getVisibleLogicalRange(), y: Math.round(scrollY) })`);
        await t.drag(p.x + p.w * 0.7, p.y + p.h * 0.5, p.x + p.w * 0.2, p.y + p.h * 0.5);
        const after = await t.ev(`({ range: Aura.charts.drawingApi().chart.timeScale().getVisibleLogicalRange(), y: Math.round(scrollY) })`);
        await t.viewport(1440, 900);
        if (Math.abs(after.range.from - before.range.from) < 1) throw new Error('el gráfico no se mueve');
        if (after.y !== before.y) throw new Error(`la página se ha desplazado ${after.y - before.y} px`);
        return `${(after.range.from - before.range.from).toFixed(1)} velas`;
      });
      await check('Comparar con EUR/USD desde su diálogo con teclado', async () => {
        await t.ev(`document.querySelector('#compareBtn').focus()`);
        await t.key('Enter');
        await t.waitFor(`document.querySelector('#compareDialog').open`, 3000, 'diálogo «Comparar»');
        await t.ev(`document.querySelector('#cmpInput').focus()`);
        await c.send('Input.insertText', { text: 'EUR/USD' });
        await t.key('Enter');
        await t.waitFor(`Aura.charts.comparing()`, 30000, 'modo Comparar');
        await sleep(800);
        const legend = await t.ev(`document.querySelector('#legend').innerText.includes('EUR/USD')`);
        await t.key('Escape');
        await t.shot('1440-comparar');
        await t.ev(`document.querySelector('#compareBtn').focus()`);
        await t.key('Enter');
        await t.waitFor(`document.querySelector('#compareDialog').open`, 3000, 'reabrir «Comparar»');
        await t.ev(`document.querySelector('#cmpClear').click()`);
        await t.key('Escape');
        await t.waitFor(`!Aura.charts.comparing()`, 5000, 'salir de Comparar');
        if (!legend) throw new Error('EUR/USD no aparece en la leyenda');
        return 'superpuesto y quitado';
      });
      await check('Backtest a 2 años solo con teclado, con IC, R y estrategias', async () => {
        await t.ev(`document.querySelector('#btOpen').focus()`);
        await t.key('Enter');
        await t.waitFor(`document.querySelector('#btDialog').open && document.activeElement.id === 'btScope'`, 3000, 'diálogo del backtest con el foco en «Valores»');
        await t.tabTo('btPeriod', 3);
        for (let i = 0; i < 4; i++) await t.key('ArrowUp');
        const period = await t.ev(`document.querySelector('#btPeriod').value`);
        await t.tabTo('btRun', 10);
        await t.key('Enter');
        await t.waitFor(`document.querySelector('#btResults table') || /No se pudo/.test(document.querySelector('#btStatus').textContent)`, 120000, 'resultados');
        const r = await t.ev(`({ status: document.querySelector('#btStatus').textContent, focus: document.activeElement.id,
          captions: [...document.querySelectorAll('#btResults caption')].map((c) => c.textContent), fee0: document.querySelector('#btT4').closest('table').querySelector('tbody tr:nth-child(2) td').textContent })`);
        // Cambiar la comisión recalcula las estrategias sin pedir datos
        await t.ev(`const f = document.querySelector('#btFee'); f.value = '1'; f.dispatchEvent(new Event('input'))`);
        const fee1 = await t.ev(`document.querySelector('#btT4').closest('table').querySelector('tbody tr:nth-child(2) td').textContent`);
        await t.shot('1440-backtest');
        await t.key('Escape');
        await t.waitFor(`!document.querySelector('#btDialog').open && document.activeElement.id === 'btOpen'`, 3000, 'Escape cierra y devuelve el foco');
        if (r.captions.length < 5) throw new Error(`faltan tablas: ${r.captions.join(' | ') || r.status}`);
        if (r.focus !== 'btResults') throw new Error(`el foco no pasa a los resultados (${r.focus})`);
        if (r.fee0 === fee1) throw new Error('la comisión no cambia las estrategias');
        return `${period} años · ${r.captions.length} tablas · «Solo con Alcista» ${r.fee0} → ${fee1} con 1 %`;
      });
      const runBt = async (scope, period) => {
        await t.ev(`document.querySelector('#btOpen').click()`);
        await t.waitFor(`document.querySelector('#btDialog').open`, 3000, 'diálogo del backtest');
        await t.ev(`document.querySelector('#btScope').value = '${scope}'; document.querySelector('#btScope').dispatchEvent(new Event('change'));
          document.querySelector('#btPeriod').value = '${period}'; document.querySelector('#btFee').value = '0,1'; document.querySelector('#btRun').click()`);
        await t.waitFor(`!document.querySelector('#btRun').disabled && /terminado|No se pudo|cancelado/.test(document.querySelector('#btStatus').textContent)`, 240000, 'fin del backtest');
        const r = await t.ev(`({ status: document.querySelector('#btStatus').textContent, title: document.querySelector('#btSymbol').textContent, summary: (document.querySelector('.bt-summary') || {}).textContent || '',
          rows: [...document.querySelectorAll('#btResults tbody tr')].map((tr) => tr.querySelector('th') && tr.querySelector('th').textContent), caption: (document.querySelector('#btResults caption') || {}).textContent || '' })`);
        await t.shot(`1440-backtest-${scope}-${period}`);
        await t.key('Escape');
        return r;
      };
      await check('Backtest de toda la watchlist: tabla comparativa', async () => {
        const r = await runBt('watchlist', '2');
        if (!/Comparación de 2 valores/.test(r.caption)) throw new Error(r.status);
        if (!r.rows.includes('AAPL') || !r.rows.includes('EUR/USD')) throw new Error(`filas: ${r.rows.join(', ')}`);
        return `${r.title} · ${r.status}`;
      });
      await check('Backtest semanal con todo el histórico', async () => {
        const r = await runBt('one', 'weekly');
        if (!/semanas evaluadas/.test(r.summary)) throw new Error(r.status);
        return r.summary.split('·').slice(1, 2).join('').trim();
      });
      await check('Notificaciones con service worker, también con el comportamiento de Android', async () => {
        await b.send('Browser.grantPermissions', { permissions: ['notifications'], origin: new URL(appUrl).origin });
        await t.ev(`document.querySelector('#alertsBtn').click()`);
        await t.waitFor(`document.querySelector('#alertsDialog').open`, 3000, 'diálogo de alertas');
        await t.ev(`document.querySelector('#alNotifBtn').click()`);
        await t.waitFor(`navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))`, 10000, 'service worker activo');
        const promise = await t.ev(`document.querySelector('#alNotifText').textContent`);
        // Como Chrome para Android: permiso concedido, pero `new Notification()` lanza un error
        const r = await t.ev(`(async () => {
          window.__RealN = window.Notification;
          window.Notification = class { constructor() { throw new TypeError("Failed to construct 'Notification': Illegal constructor."); } static get permission() { return 'granted'; } };
          const reg = await navigator.serviceWorker.getRegistration();
          (await reg.getNotifications()).forEach((n) => n.close());
          const a = Aura.alerts.add({ symbol: 'AAPL', type: 'price_above', value: 1 }).alert;
          await Aura.monitor.checkAlertsQuick();
          await new Promise((ok) => setTimeout(ok, 800));
          const viaSw = (await reg.getNotifications()).map((n) => n.title);
          // Sin service worker (navegador que no lo admite): no se promete lo que no llega
          Aura.monitor.setNotifier(null);
          const b2 = Aura.alerts.add({ symbol: 'AAPL', type: 'price_above', value: 2 }).alert;
          await Aura.monitor.checkAlertsQuick();
          const blocked = Aura.monitor.systemBlocked();
          [a, b2].forEach((x) => Aura.alerts.remove(x.id));
          (await reg.getNotifications()).forEach((n) => n.close());
          window.Notification = window.__RealN;
          return { viaSw, blocked };
        })()`);
        await t.key('Escape');
        await t.ev(`document.querySelector('#alertsBtn').click()`);
        await t.waitFor(`document.querySelector('#alertsDialog').open`, 3000, 'diálogo de alertas');
        const honest = await t.ev(`document.querySelector('#alNotifText').textContent`);
        await t.ev(`document.querySelector('#alNotifBtn').click()`);              // desactivar
        await t.key('Escape');
        if (!/Recibirás notificaciones/.test(promise)) throw new Error(`al activarlas: «${promise}»`);
        if (!r.viaSw.includes('Aura Invest · AAPL')) throw new Error('la notificación no sale por el service worker');
        if (!r.blocked || !/no ha dejado/.test(honest)) throw new Error(`sin service worker sigue prometiendo: «${honest}»`);
        return 'mostrada por el service worker; sin él, Ajustes lo dice';
      });
      await check('Cartera: aviso de split con cierres reales de AAPL (4 por 1 en 2020)', async () => {
        // Compra anotada a 470 $, el precio de antes del split de 2020 (en el perfil temporal)
        const id = await t.ev(`Aura.portfolio.add({ type: 'buy', symbol: 'AAPL', date: '2020-08-20', quantity: 10, price: 470, fees: 0, currency: 'USD' }).tx.id`);
        await t.ev(`document.querySelector('#tabPortfolio').click()`);
        await t.waitFor(`!document.querySelector('#viewPortfolio').classList.contains('is-loading') && /split|antiguos|sin histórico/.test(document.querySelector('#pfStatus').textContent)`, 90000, 'estado de la Cartera');
        const txt = await t.ev(`document.querySelector('#pfStatus').innerText`);
        await t.shot('1440-cartera-split');
        await t.ev(`Aura.portfolio.remove(${JSON.stringify(id)}); document.querySelector('#tabMarket').click()`);
        if (!/split 4 por 1 del 31 ago 2020/.test(txt) || !/multiplica su cantidad por 4/.test(txt)) throw new Error(`sin el aviso esperado: «${txt.slice(0, 200)}»`);
        return 'avisa: multiplicar la cantidad por 4 y dividir el precio entre 4';
      });
      const ready = (sym, tf) => t.waitFor(`Aura.state.symbol === '${sym}' && Aura.state.tf === '${tf}' && Aura.state.model && Aura.state.model.meta.id === '${sym}' && !document.body.classList.contains('is-loading')`, 60000, `${sym} ${tf} cargado`);
      await check('EUR/USD en intradía: en tu hora local y con sesión de 24 h', async () => {
        await t.ev(`document.querySelector('.wl-chip[data-sym="EUR/USD"]').click()`);
        await t.waitFor(`Aura.state.model && Aura.state.model.meta.id === 'EUR/USD' && !document.body.classList.contains('is-loading')`, 60000, 'EUR/USD cargado');
        await t.ev(`document.querySelector('button[data-tf="1D"]').click()`);
        await ready('EUR/USD', '1D');
        const r = await t.ev(`(() => { const m = Aura.state.model; const lastUtc = Aura.utils.wallToUtc(m.vis.at(-1).time, m.meta.timezone);
          return { basis: m.meta.timeBasis, tz: m.meta.timezone, session: m.meta.session, ageMin: Math.round((Date.now() / 1000 - lastUtc) / 60), weekend: [0, 6].includes(new Date().getUTCDay()),
            label: document.querySelector('#statusBar').innerText.includes('tu hora local') }; })()`);
        await t.shot('1440-eurusd-1d');
        if (r.basis !== 'local' || r.tz !== Intl.DateTimeFormat().resolvedOptions().timeZone) throw new Error(`zona ${r.tz} (${r.basis})`);
        if (r.session[0] !== 0 || r.session[1] !== 1440) throw new Error(`sesión ${JSON.stringify(r.session)}`);
        if (!r.label) throw new Error('la barra de estado no dice en qué hora están las velas');
        if (!r.weekend && (r.ageMin < -10 || r.ageMin > 90)) throw new Error(`la última vela está a ${r.ageMin} min de ahora: horas mal alineadas`);
        return `${r.tz}; última vela hace ${r.ageMin} min`;
      });
      await check('Comparar en intradía: AAPL (Nueva York) y EUR/USD alineados en UTC', async () => {
        await t.ev(`document.querySelector('.wl-chip[data-sym="AAPL"]').click()`);
        await ready('AAPL', '1D');
        await t.ev(`document.querySelector('button[data-tf="5D"]').click()`);
        await ready('AAPL', '5D');
        const r = await t.ev(`Aura.data.fetchMarketData('EUR/USD', '5D').then((d) => { const m = Aura.state.model;
          const v = Aura.charts.percentSeriesUtc(m.vis, m.meta.timezone, d.bars, d.meta.timezone);
          const i = v.findIndex((x) => x != null);
          return { filled: v.filter((x) => x != null).length, n: v.length,
            firstUtc: i >= 0 ? Aura.utils.wallToUtc(m.vis[i].time, m.meta.timezone) : null, fxFirstUtc: Aura.utils.wallToUtc(d.bars[0].time, d.meta.timezone),
            mainLastUtc: Aura.utils.wallToUtc(m.vis.at(-1).time, m.meta.timezone) }; })`);
        if (r.fxFirstUtc > r.mainLastUtc) return 'sin horas en común en la ventana (no se puede comprobar ahora)';
        if (!r.filled) throw new Error('EUR/USD sin datos en horas en las que sí cotizaba');
        if (r.firstUtc < r.fxFirstUtc) throw new Error('se usan datos de EUR/USD anteriores a su primera vela');
        return `${r.filled} de ${r.n} velas de AAPL con dato de EUR/USD`;
      });
    }

    await check('Consola sin errores ni excepciones', async () => {
      if (problems.length) throw new Error(problems.slice(0, 5).join(' | '));
      return 'ninguno';
    });
  } catch (err) {
    results.push({ ok: false, name: 'Ejecución', detail: err.message });
    console.log(`  ✘ ${err.message}`);
  } finally {
    if (c) c.close();
    if (b) { await b.send('Browser.close').catch(() => {}); b.close(); }
    await new Promise((r) => { if (browser.exitCode != null) r(); else { browser.once('exit', r); setTimeout(r, 5000); } });
    server.kill();
    if (!args.keep) { await sleep(500); try { rmSync(profile, { recursive: true, force: true }); } catch { /* el navegador puede tardar en soltarlo */ } }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas. Capturas en ${outDir}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
