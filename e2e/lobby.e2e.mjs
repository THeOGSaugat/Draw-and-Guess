// End-to-end lobby checks in a real (headless) Chrome, driven over the DevTools
// protocol with no extra dependencies. Each isolated browser context is a
// separate player. Run with `npm run test:e2e` (builds first).
//
// Needs Google Chrome/Chromium. Set CHROME_PATH if it isn't auto-detected.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.E2E_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT || 9339);
const HOST_HANDOFF_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((p) => p && existsSync(p));
}

async function waitFor(check, { timeout = 5000, interval = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch {
      // keep polling
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

// ── Server (production build: serves client + socket on one port) ─────────────
let server = null;
async function startServer() {
  if (!existsSync(join(root, 'client/dist/index.html')) || !existsSync(join(root, 'server/dist/index.js'))) {
    throw new Error('Build output missing. Run `npm run build` first (npm run test:e2e does this).');
  }
  server = spawn(process.execPath, [join(root, 'server/dist/index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HOST_HANDOFF_MS: String(HOST_HANDOFF_MS) },
    stdio: 'ignore',
  });
  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { message: 'server health' });
}
async function stopServer() {
  if (!server) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await exited;
  server = null;
}

// ── Minimal CDP client ───────────────────────────────────────────────────────
const chromePath = findChrome();
if (!chromePath) {
  console.error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium executable.');
  process.exit(1);
}
const profileDir = mkdtempSync(join(tmpdir(), 'dg-e2e-'));
const chrome = spawn(
  chromePath,
  [`--headless=new`, `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' },
);

let ws;
let nextId = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  return new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function openPage({ width = 390, height = 844, context, sessionStorageSeed } = {}) {
  const browserContextId = context ?? (await send('Target.createBrowserContext')).browserContextId;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 }, sessionId);
  if (sessionStorageSeed) {
    // Mimics "Duplicate tab", which copies the original tab's sessionStorage.
    await send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: `try { for (const [k, v] of Object.entries(${JSON.stringify(sessionStorageSeed)})) sessionStorage.setItem(k, v); } catch {}` },
      sessionId,
    );
  }
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result.value;
  };
  const page = {
    context: browserContextId,
    evaluate,
    goto: async (path) => {
      await send('Page.navigate', { url: BASE + path }, sessionId);
      await waitFor(() => evaluate('document.readyState === "complete" && !!document.querySelector("#root > *")'), {
        message: 'page load',
      });
    },
    text: () => evaluate('document.body.innerText'),
    hasText: (needle, timeout = 5000) =>
      waitFor(async () => (await page.text()).includes(needle), { timeout, message: `text "${needle}"` }).then(() => true),
    value: (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.value`),
    fill: async (sel, text) => {
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select(); })()`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
      await send('Input.insertText', { text }, sessionId);
    },
    click: (label) =>
      evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(label)}) || b.getAttribute('aria-label') === ${JSON.stringify(label)});
        if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';
      })()`),
    resize: (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 }, sessionId),
    overflowX: () => evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'),
    roomCode: () => evaluate(`new URL(location.href).searchParams.get('room')`),
    session: () => evaluate(`sessionStorage.getItem('dg:session')`),
    close: () => send('Target.closeTarget', { targetId }),
  };
  return page;
}

// ── Test runner ──────────────────────────────────────────────────────────────
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✖ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

async function newPlayer(nickname, path = '/', opts) {
  const page = await openPage(opts);
  await page.goto(path);
  await page.hasText('Online');
  if (nickname) await page.fill('#nickname', nickname);
  return page;
}

try {
  await startServer();
  const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(), {
    message: 'Chrome DevTools',
  });
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  console.log('Lobby flow');
  let alice, bob, code;
  await step('host creates a room', async () => {
    alice = await newPlayer('Alice');
    expect((await alice.click('Create Room')) === 'clicked', 'Create Room not clickable');
    await alice.hasText('Players');
    code = await alice.roomCode();
    expect(/^[A-Z2-9]{5}$/.test(code ?? ''), `bad room code in URL: ${code}`);
    expect((await alice.click('Start Game')) === 'disabled', 'Start should be disabled with one player');
  });

  await step('invite link pre-fills the code; duplicate nickname is rejected', async () => {
    bob = await newPlayer('ALICE', `/?room=${code}`);
    expect((await bob.value('#room-code')) === code, 'code not pre-filled');
    await bob.click('Join');
    await bob.hasText('already has that nickname');
  });

  await step('guest joins and both lobbies update', async () => {
    await bob.fill('#nickname', 'Bob');
    await bob.click('Join');
    await bob.hasText('Waiting for Alice');
    await alice.hasText('Bob');
  });

  await step('Devanagari nickname can join', async () => {
    const p = await newPlayer('सौगात');
    await p.fill('#room-code', code);
    await p.click('Join');
    await p.hasText('Waiting for Alice');
    await p.click('Leave room');
    await p.hasText('Create Room');
    await p.close();
  });

  await step('pasting a full invite link into the code box extracts the code', async () => {
    const p = await newPlayer('Paster');
    await p.fill('#room-code', `http://example.test/?room=${code.toLowerCase()}&x=1`);
    expect((await p.value('#room-code')) === code, `got "${await p.value('#room-code')}"`);
    await p.close();
  });

  await step('unknown room code shows an error', async () => {
    const p = await newPlayer('Carol');
    await p.fill('#room-code', 'ZZZZZ');
    await p.click('Join');
    await p.hasText("couldn't find a room");
    await p.close();
  });

  await step('reloading a tab restores the same seat', async () => {
    await bob.goto(`/?room=${code}`);
    await bob.hasText('Waiting for Alice');
  });

  await step('duplicated tab does not steal the original seat', async () => {
    const seed = { 'dg:session': await alice.session() };
    const dup = await openPage({ context: alice.context, sessionStorageSeed: seed });
    await dup.goto(`/?room=${code}`);
    await dup.hasText('already open in another tab');
    expect((await dup.value('#room-code')) === code, 'duplicate tab should pre-fill the room code');
    await sleep(300);
    expect((await alice.text()).includes('Start Game'), 'original tab must stay in the lobby');
    await dup.close();
  });

  await step('no horizontal overflow at 320 / 390 / 768 / 1280px', async () => {
    for (const [w, h] of [[320, 640], [390, 844], [768, 1024], [1280, 800]]) {
      await alice.resize(w, h);
      await sleep(150);
      const overflow = await alice.overflowX();
      expect(overflow <= 0, `${w}px overflows by ${overflow}px`);
    }
    await alice.resize(390, 844);
  });

  await step('host starts; late joiner is refused; host returns to lobby', async () => {
    expect((await alice.click('Start Game')) === 'clicked', 'Start not clickable');
    await bob.hasText('Game started!');
    const late = await newPlayer('Dave');
    await late.fill('#room-code', code);
    await late.click('Join');
    await late.hasText('already started');
    await late.close();
    await alice.click('Back to lobby');
    await bob.hasText('Waiting for Alice');
  });

  await step(`host role moves to a connected player ~${HOST_HANDOFF_MS}ms after the host drops`, async () => {
    const seed = { 'dg:session': await alice.session() };
    await alice.close();
    await bob.hasText('host lost connection', 3000);
    await bob.hasText('Start Game', 3000);
    // The old host comes back (same session) as a regular player.
    alice = await openPage({ sessionStorageSeed: seed });
    await alice.goto(`/?room=${code}`);
    await alice.hasText('Waiting for Bob');
  });

  console.log('Connection handling');
  await step('server outage shows Reconnecting; restart returns home with code pre-filled', async () => {
    await stopServer();
    await bob.hasText('Connection lost', 5000);
    expect((await bob.click('Start Game')) === 'disabled', 'Start should be disabled while offline');
    await startServer();
    await bob.hasText('expired', 15000);
    expect((await bob.value('#room-code')) === code, 'room code should be pre-filled after expiry');
  });
} catch (err) {
  failures++;
  console.error('E2E setup error:', err);
} finally {
  ws?.close();
  chrome.kill();
  await stopServer().catch(() => {});
  await sleep(200);
  rmSync(profileDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} e2e check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
