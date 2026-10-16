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
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
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
    resize: (w, h, dpr = 1) =>
      send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: w < 768 }, sessionId),
    overflowX: () => evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'),
    roomCode: () => evaluate(`new URL(location.href).searchParams.get('room')`),
    session: () => evaluate(`sessionStorage.getItem('dg:session')`),
    close: () => send('Target.closeTarget', { targetId }),
    shot: async (name) => {
      if (!process.env.E2E_SHOTS) return;
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(process.env.E2E_SHOTS, { recursive: true });
      writeFileSync(join(process.env.E2E_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    },
    rect: (sel) =>
      evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; })()`),
    viewport: () => evaluate('({ w: innerWidth, h: innerHeight })'),
    /**
     * Count of dark pixels (sampled), composited over white so a stroke counts the
     * same whether it is still on the transparent live layer or committed to the base.
     */
    ink: () =>
      evaluate(`(() => { let n = 0; for (const c of document.querySelectorAll('canvas')) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 16) if ((d[i + 3] * (255 - Math.min(d[i], d[i + 1], d[i + 2]))) / 255 > 60) n++; } return n; })()`),
    /** Ink count once it has stopped changing (rendering is frame-based). */
    stableInk: async () => {
      let last = -1;
      for (let i = 0; i < 20; i++) {
        const now = await page.ink();
        if (now === last) return now;
        last = now;
        await sleep(100);
      }
      return last;
    },
    /**
     * Whether `word` appears as a whole word anywhere a player could find it: all text
     * (including hidden elements) and every attribute except class/style.
     */
    containsWord: (word) => {
      const pattern = `(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`;
      return evaluate(`(() => {
        const re = new RegExp(${JSON.stringify(pattern)}, 'i');
        // Test each text node separately: textContent glues adjacent elements together.
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) if (re.test(walker.currentNode.data)) return true;
        for (const el of document.querySelectorAll('*')) {
          for (const a of el.attributes) if (a.name !== 'class' && a.name !== 'style' && re.test(a.value)) return true;
          if ('value' in el && typeof el.value === 'string' && re.test(el.value)) return true;
        }
        return false;
      })()`);
    },
    scrolled: () => evaluate('Math.max(scrollY, document.scrollingElement.scrollTop, document.body.scrollTop)'),
    /** Draws a zig-zag with touch input across the canvas (fractions of its size). */
    touchDraw: async (path) => {
      const r = await page.rect('canvas[role="img"]');
      const at = ([fx, fy]) => ({ x: r.x + fx * r.w, y: r.y + fy * r.h, id: 1 });
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(path[0])] }, sessionId);
      for (const p of path.slice(1)) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(p)] }, sessionId);
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    },
    mouseDraw: async (path) => {
      const r = await page.rect('canvas[role="img"]');
      const at = ([fx, fy]) => ({ x: r.x + fx * r.w, y: r.y + fy * r.h });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...at(path[0]) }, sessionId);
      for (const p of path.slice(1)) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...at(p) }, sessionId);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, ...at(path.at(-1)) }, sessionId);
    },
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
    await bob.hasText('is choosing');
    const late = await newPlayer('Dave');
    await late.fill('#room-code', code);
    await late.click('Join');
    await late.hasText('already started');
    await late.close();
    await alice.click('Game menu');
    await alice.click('Back to lobby');
    await bob.hasText('Waiting for Alice');
  });

  console.log('Drawing round');
  let drawer, guesser, word;
  const ZIGZAG = [[0.2, 0.2], [0.35, 0.5], [0.5, 0.25], [0.65, 0.55], [0.8, 0.3], [0.8, 0.7]];

  await step('host starts a round; only the drawer is offered word choices', async () => {
    expect((await alice.click('Start Game')) === 'clicked', 'Start not clickable');
    await waitFor(async () => (await alice.text()).includes('Pick a word to draw') || (await bob.text()).includes('Pick a word to draw'), {
      message: 'word choices',
    });
    [drawer, guesser] = (await alice.text()).includes('Pick a word to draw') ? [alice, bob] : [bob, alice];
    await guesser.hasText('is choosing a word');
    const choices = await drawer.evaluate(`[...document.querySelectorAll('[aria-label="Choose a word"] button')].map((b) => b.textContent.trim())`);
    expect(choices.length === 3, `expected 3 choices, got ${JSON.stringify(choices)}`);
    for (const c of choices) expect(!(await guesser.containsWord(c)), `guesser's page contains choice "${c}"`);
    expect(await drawer.containsWord(choices[0]), 'sanity check: containsWord finds a visible word');
    await drawer.click(choices[0]);
    await drawer.hasText('Draw this word');
    word = choices[0];
    await guesser.hasText('letters');
    expect(!(await guesser.containsWord(word)), 'guesser page leaked the word');
    await drawer.shot('round-drawer-390');
  });

  await step('drawer draws with touch; the guesser sees it; the page never scrolls', async () => {
    expect((await guesser.ink()) === 0, 'canvas should start blank');
    await drawer.touchDraw(ZIGZAG);
    expect((await drawer.ink()) > 50, 'drawer sees their own stroke');
    await waitFor(async () => (await guesser.ink()) > 50, { message: 'stroke on guesser canvas' });
    expect((await drawer.scrolled()) === 0, 'page scrolled while drawing');
    await guesser.shot('round-guesser-390');
  });

  await step('guesser cannot draw', async () => {
    const before = await drawer.stableInk();
    const guesserBefore = await guesser.stableInk();
    await guesser.touchDraw([[0.1, 0.9], [0.9, 0.9]]);
    await sleep(300);
    expect((await drawer.stableInk()) === before, "guesser's touch changed the drawer's canvas");
    expect((await guesser.stableInk()) === guesserBefore, "guesser's touch drew on their own canvas");
  });

  await step('drawer clears the canvas (with confirmation) for everyone', async () => {
    await drawer.click('Clear drawing');
    expect((await drawer.ink()) > 0, 'first tap must only ask for confirmation');
    await drawer.click('Tap again to clear the whole drawing');
    await waitFor(async () => (await guesser.ink()) === 0 && (await drawer.ink()) === 0, { message: 'cleared canvases' });
    await drawer.touchDraw(ZIGZAG);
    await waitFor(async () => (await guesser.ink()) > 50, { message: 'drawing after clear' });
  });

  await step('a reloading guesser gets the current drawing back', async () => {
    await guesser.goto(`/?room=${code}`);
    await waitFor(async () => (await guesser.ink()) > 50, { message: 'restored drawing' });
    await guesser.hasText('letters');
  });

  await step('wrong guesses appear as chat; the right one ends the round and reveals the word', async () => {
    await guesser.fill('#chat-input', 'definitely not it');
    await guesser.click('Send');
    await drawer.hasText('definitely not it');
    await guesser.fill('#chat-input', `  ${word.toUpperCase()} `);
    await guesser.click('Send');
    await guesser.hasText('You guessed the word!');
    await drawer.hasText('guessed the word!');
    for (const p of [drawer, guesser]) await p.hasText('The word was');
    await guesser.shot('round-end-390');
  });

  await step('next round rotates the drawer', async () => {
    const host = alice;
    expect((await host.click('Next round')) === 'clicked', 'Next round not clickable');
    await guesser.hasText('Pick a word to draw');
    await drawer.hasText('is choosing a word');
    [drawer, guesser] = [guesser, drawer];
    const choices = await drawer.evaluate(`[...document.querySelectorAll('[aria-label="Choose a word"] button')].map((b) => b.textContent.trim())`);
    await drawer.click(choices[1]);
    word = choices[1];
    await guesser.hasText('letters');
  });

  await step('layouts fit at 320/360/390/430px and tablet/desktop; input stays visible with the keyboard open', async () => {
    for (const p of [drawer, guesser]) {
      for (const [w, h] of [[320, 568], [360, 740], [390, 844], [430, 932], [768, 1024], [1280, 800]]) {
        await p.resize(w, h);
        await sleep(200);
        const overflow = await p.overflowX();
        expect(overflow <= 0, `${w}px overflows by ${overflow}px`);
        const canvas = await p.rect('canvas[role="img"]');
        expect(canvas.w >= Math.min(200, w * 0.5) && canvas.right <= w && canvas.bottom <= h, `${w}x${h}: canvas ${JSON.stringify(canvas)}`);
        const bottomControl = await p.rect(p === guesser ? '#chat-input' : '[aria-label="Clear drawing"]');
        expect(bottomControl && bottomControl.bottom <= h, `${w}x${h}: bottom control off-screen ${JSON.stringify(bottomControl)}`);
      }
    }
    // Simulated open keyboard: the visual viewport shrinks to ~half the screen.
    await guesser.resize(390, 420);
    await sleep(250);
    const input = await guesser.rect('#chat-input');
    const canvas = await guesser.rect('canvas[role="img"]');
    expect(input.bottom <= 420 && input.y >= 0, `input hidden with keyboard open: ${JSON.stringify(input)}`);
    expect(canvas.w >= 100, `canvas too small with keyboard open: ${canvas.w}`);
    await guesser.shot('keyboard-open-390x420');
    await drawer.resize(320, 568);
    await sleep(200);
    await drawer.shot('drawer-320');
    const buttons = await drawer.evaluate(`[...document.querySelectorAll('[role="toolbar"] button')].map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); })`);
    expect(Math.min(...buttons) >= 32, `toolbar touch targets too small: ${Math.min(...buttons)}px`);
    for (const p of [drawer, guesser]) await p.resize(390, 844);
  });

  await step('rotating to landscape and back keeps the drawing and a usable layout', async () => {
    await drawer.touchDraw(ZIGZAG);
    await waitFor(async () => (await guesser.ink()) > 50, { message: 'stroke before rotation' });
    for (const [w, h] of [[844, 390], [390, 844]]) {
      for (const p of [drawer, guesser]) await p.resize(w, h);
      await sleep(250);
      for (const p of [drawer, guesser]) {
        expect((await p.stableInk()) > 50, `${w}x${h}: drawing lost after resize`);
        expect((await p.overflowX()) <= 0, `${w}x${h}: horizontal overflow`);
        const canvas = await p.rect('canvas[role="img"]');
        expect(canvas.w >= 200 && canvas.bottom <= h, `${w}x${h}: canvas ${JSON.stringify(canvas)}`);
      }
      const input = await guesser.rect('#chat-input');
      expect(input.bottom <= h, `${w}x${h}: guess input off-screen`);
      if (w > h) {
        await drawer.shot('drawer-landscape');
        await guesser.shot('guesser-landscape');
      }
    }
  });

  await step('high-DPI phones (2x/3x) get a sharp backing store and the restored drawing', async () => {
    for (const dpr of [2, 3]) {
      // Loads the page at this density, like a real phone. (Changing DPR after load relies on a
      // matchMedia change event that DevTools emulation never fires, so that path isn't tested here.)
      await guesser.resize(390, 844, dpr);
      await guesser.goto(`/?room=${code}`);
      await guesser.hasText('letters');
      await sleep(250);
      const sizes = await guesser.evaluate(
        `[...document.querySelectorAll('canvas')].map((c) => [c.width, c.getBoundingClientRect().width])`,
      );
      for (const [backing, css] of sizes) {
        expect(Math.abs(backing - Math.round(css * dpr)) <= 1, `DPR ${dpr}: backing ${backing}px for ${css}px canvas`);
      }
      expect((await guesser.stableInk()) > 50, `DPR ${dpr}: drawing lost`);
      if (dpr === 3) await guesser.shot('guesser-dpr3');
    }
    await guesser.resize(390, 844);
  });

  await step('mouse drawing works on desktop and lands on the guesser canvas', async () => {
    await drawer.resize(1280, 800);
    await sleep(200);
    await drawer.mouseDraw([[0.1, 0.1], [0.5, 0.5], [0.9, 0.2]]);
    await waitFor(async () => (await guesser.ink()) > 50, { message: 'mouse stroke on guesser canvas' });
    await drawer.shot('drawer-desktop');
    await drawer.resize(390, 844);
    await alice.click('Game menu');
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

  console.log('Five-round match');
  // A separate room with deliberately awkward nicknames: 16 characters, and Devanagari.
  const LONG = 'Maximilianus Lon';
  const NEPALI = 'सौगात लामा';
  let p1, p2, matchCode;
  const roundChip = (p) => p.evaluate(`document.querySelector('[aria-label^="Round "][aria-label*=" of "]')?.getAttribute('aria-label') ?? null`);
  const pickDrawer = async () => {
    await waitFor(async () => (await p1.text()).includes('Pick a word to draw') || (await p2.text()).includes('Pick a word to draw'), {
      message: 'a drawer with word choices',
    });
    return (await p1.text()).includes('Pick a word to draw') ? [p1, p2] : [p2, p1];
  };

  await step('a complete five-round match: round counter, live scores, results, final leaderboard', async () => {
    p1 = await newPlayer(LONG);
    await p1.click('Create Room');
    await p1.hasText('Players');
    matchCode = await p1.roomCode();
    p2 = await newPlayer(NEPALI, `/?room=${matchCode}`);
    await p2.click('Join');
    await p2.hasText('Waiting for');
    expect((await p1.click('Start Game')) === 'clicked', 'Start not clickable');

    let lastTotals = null;
    for (let n = 1; n <= 5; n++) {
      const [d, g] = await pickDrawer();
      for (const p of [d, g]) expect((await roundChip(p)) === `Round ${n} of 5`, `round chip on round ${n}: ${await roundChip(p)}`);
      const choices = await d.evaluate(`[...document.querySelectorAll('[aria-label="Choose a word"] button')].map((b) => b.textContent.trim())`);
      await d.click(choices[0]);
      const w = choices[0];
      await g.hasText('letters');
      expect(!(await g.containsWord(w)), `round ${n}: guesser page shows the word before guessing`);
      await d.touchDraw(ZIGZAG);
      const count = async (p, re) => ((await p.text()).match(re) ?? []).length;
      // Only in the first rounds: these bots play far faster than people, and the chat
      // limit (5 messages / 5s per player) would otherwise catch the real guess.
      if (n <= 2) {
        const before = await count(d, /guessed the word/g);
        await g.fill('#chat-input', `maybe ${w}?`); // contains the answer: must not leak or score
        await g.click('Send');
        await g.hasText(`maybe ${w}?`); // the sender sees their own message as usual
        await waitFor(async () => (await d.text()).includes('(hidden from guessers)'), { message: 'withheld label for the drawer' });
        expect((await count(d, /guessed the word/g)) === before, 'a message containing the word must not count as a guess');
      }
      const mine = await count(g, /You guessed the word!/g);
      await g.fill('#chat-input', w);
      await g.click('Send');
      await waitFor(async () => (await count(g, /You guessed the word!/g)) === mine + 1, { message: `round ${n} correct guess` });
      expect(/You guessed the word!\s*\+\d+/.test(await g.text()), 'correct-guess feedback shows the points earned');
      // 2 players: one correct guess ends the round → results card on both screens.
      for (const p of [d, g]) {
        // textContent, not innerText: the card header is CSS-uppercased.
        await waitFor(
          () => p.evaluate(`document.querySelector('[aria-label="Round results"]')?.textContent.includes('Round ${n} of 5') ?? false`),
          { message: `round ${n} results card` },
        );
      }
      for (const p of [d, g]) await p.hasText('The word was');
      const totals = await g.evaluate(
        `[...document.querySelectorAll('[aria-label="Round results"] tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))`,
      );
      expect(totals.length === 2, `results rows: ${JSON.stringify(totals)}`);
      const guesserRow = totals.find((r) => r[0] === 'You');
      const pts = Number(guesserRow[1].replace('+', ''));
      expect(pts >= 50 && pts <= 100, `guesser points ${pts}`);
      const drawerRow = totals.find((r) => r[0] !== 'You');
      expect(drawerRow[1] === '+25', `drawer earned ${drawerRow[1]}`);
      if (n === 3) {
        for (const [w2, h2] of [[320, 568], [360, 740]]) {
          await g.resize(w2, h2);
          await sleep(150);
          expect((await g.overflowX()) <= 0, `results card overflows at ${w2}px`);
        }
        await g.shot('results-320');
        await g.resize(390, 844);
      }
      lastTotals = totals;
      const host = p1;
      expect((await host.click(n < 5 ? 'Next round' : 'See final results')) === 'clicked', `host advance on round ${n}`);
    }

    for (const p of [p1, p2]) await p.hasText('Match over');
    const rows = await p1.evaluate(
      `[...document.querySelectorAll('[aria-label="Final standings"] li')].map((li) => li.getAttribute('aria-label'))`,
    );
    expect(rows.length === 2, `standings rows ${JSON.stringify(rows)}`);
    const scores = rows.map((r) => Number(/, (\d+) points/.exec(r)[1]));
    expect(scores[0] >= scores[1], `standings not sorted: ${scores}`);
    expect(rows[0].startsWith('1st place'), rows[0]);
    const finalTotals = lastTotals.map((r) => Number(r[2])).sort((a, b) => b - a);
    expect(JSON.stringify(finalTotals) === JSON.stringify(scores), `leaderboard ${scores} vs last round totals ${finalTotals}`);
    const winnerText = scores[0] === scores[1] ? "It's a tie!" : 'win';
    for (const p of [p1, p2]) await p.hasText(winnerText);
    expect((await p1.text()).includes('Play Again') && (await p1.text()).includes('Return to Lobby'), 'host actions');
    await p2.hasText('to play again or return to the lobby');
  });

  await step('final leaderboard fits phones (320–430px) with long and Devanagari nicknames', async () => {
    for (const p of [p1, p2]) {
      for (const [w, h] of [[320, 568], [360, 740], [390, 844], [430, 932], [1280, 800]]) {
        await p.resize(w, h);
        await sleep(150);
        const overflow = await p.overflowX();
        expect(overflow <= 0, `${w}px: leaderboard overflows by ${overflow}px`);
        const list = await p.rect('[aria-label="Final standings"]');
        expect(list && list.right <= w && list.w > 150, `${w}px: standings ${JSON.stringify(list)}`);
        // Both rows must be fully visible inside the list and on screen (scroll the panel if needed).
        await p.evaluate(`document.querySelector('[aria-label="Final standings"]').scrollIntoView({ block: 'nearest' })`);
        const rows = await p.evaluate(
          `[...document.querySelectorAll('[aria-label="Final standings"] li')].map((li) => { const r = li.getBoundingClientRect(); return [r.top, r.bottom, r.height]; })`,
        );
        const box = await p.rect('[aria-label="Final standings"]');
        for (const [top, bottom, height] of rows) {
          expect(height >= 40 && top >= box.y - 1 && bottom <= box.bottom + 1 && bottom <= h, `${w}x${h}: standings row clipped (${top}-${bottom} in ${box.y}-${box.bottom})`);
        }
        const action = await p.rect(p === p1 ? '[aria-label="Final results"] button' : '[aria-label="Final results"] p:last-child');
        expect(action && action.bottom <= h, `${w}px: actions off-screen ${JSON.stringify(action)}`);
      }
      await p.resize(320, 568);
      await sleep(150);
    }
    await p1.shot('leaderboard-320-host');
    await p2.shot('leaderboard-320-guest');
    for (const p of [p1, p2]) await p.resize(390, 844);
  });

  await step('Play Again starts a clean rematch exactly once', async () => {
    const before = await p1.evaluate(`document.querySelectorAll('[aria-label="Final standings"] li').length`);
    expect(before === 2, 'on the leaderboard');
    // Double-tap: the second request must not start a second match.
    await p1.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Play Again')); b.click(); b.click(); })()`);
    for (const p of [p1, p2]) await waitFor(async () => (await roundChip(p)) === 'Round 1 of 5', { message: 'rematch round 1' });
    const strip = await p2.evaluate(`[...document.querySelectorAll('[aria-label="Players"] li')].map((li) => li.getAttribute('aria-label'))`);
    expect(strip.every((s) => s.endsWith(', 0 points')), `scores not reset: ${JSON.stringify(strip)}`);
    expect((await p1.ink()) === 0 && (await p2.ink()) === 0, 'canvas not reset');
    const [d] = await pickDrawer();
    expect(d, 'a drawer was chosen');
  });

  await step('Return to Lobby keeps everyone in the room', async () => {
    await p1.click('Game menu');
    await p1.click('Back to lobby');
    for (const p of [p1, p2]) await p.hasText('Players');
    await p2.hasText(`Waiting for ${LONG}`);
    expect((await p1.text()).includes('Start Game'), 'host can start again');
    await p1.close();
    await p2.close();
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
