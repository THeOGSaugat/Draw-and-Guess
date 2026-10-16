import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type {
  AckResult,
  ChatMessage,
  ClientToServerEvents,
  DrawOp,
  DrawOpsPayload,
  JoinedRoom,
  PrivateRoundInfo,
  RoomSnapshot,
  ServerToClientEvents,
} from '@draw-guess/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { createApp, type AppInstance } from '../src/createApp.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

// Distinctive words so "never appears in any event" checks can't match by accident.
const TEST_WORDS = ['zebracorn', 'quokkaship', 'yetibanjo'];

const apps: AppInstance[] = [];
const clients: Client[] = [];

async function startApp(overrides: { drawTimeMs?: number; wordChoiceMs?: number } = {}) {
  const app = createApp({
    corsOrigins: [],
    maxPlayersPerRoom: 8,
    maxRooms: 50,
    reconnectGraceMs: 2000,
    hostHandoffMs: 2000,
    wordChoiceMs: 5000,
    drawTimeMs: 5000,
    roundResultsMs: 5000,
    words: TEST_WORDS,
    ...overrides,
  });
  apps.push(app);
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  return { app, url: `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}` };
}

after(async () => {
  clients.forEach((c) => c.disconnect());
  for (const app of apps) {
    app.rooms.dispose();
    await app.io.close();
  }
});

/** A connected client that records every server event it receives. */
async function client(url: string): Promise<Client & { events: { event: string; args: unknown[] }[] }> {
  const c = connect(url, { transports: ['websocket'], forceNew: true }) as Client & {
    events: { event: string; args: unknown[] }[];
  };
  c.events = [];
  c.onAny((event, ...args) => c.events.push({ event, args }));
  clients.push(c);
  await new Promise<void>((resolve, reject) => {
    c.once('connect', resolve);
    c.once('connect_error', reject);
  });
  return c;
}

function emitRaw<T>(c: Client, event: string, ...args: unknown[]): Promise<AckResult<T>> {
  return new Promise((resolve) => (c.emit as (...a: unknown[]) => void)(event, ...args, resolve));
}
function emitNoAck(c: Client, event: string, payload: unknown) {
  (c.emit as (...a: unknown[]) => void)(event, payload);
}
function ok<T>(result: AckResult<T>): T {
  if (!result.ok) assert.fail(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}
function errorCode(result: AckResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitFor<T>(c: Client, event: string, match: (arg: T) => boolean = () => true, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      (c.off as (e: string, l: unknown) => void)(event, listener);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (arg: T) => {
      if (!match(arg)) return;
      clearTimeout(timer);
      (c.off as (e: string, l: unknown) => void)(event, listener);
      resolve(arg);
    };
    (c.on as (e: string, l: unknown) => void)(event, listener);
  });
}

function received<T>(c: { events: { event: string; args: unknown[] }[] }, event: string): T[] {
  return c.events.filter((e) => e.event === event).map((e) => e.args[0] as T);
}

/** Creates a room with the given nicknames; the first player is host (and first drawer). */
async function room(url: string, ...nicknames: string[]) {
  const [hostName, ...rest] = nicknames;
  const host = await client(url);
  const created = ok(await emitRaw<JoinedRoom>(host, 'room:create', { nickname: hostName }));
  const others = [];
  for (const nickname of rest) {
    const c = await client(url);
    const seat = ok(await emitRaw<JoinedRoom>(c, 'room:join', { code: created.room.code, nickname }));
    others.push({ c, seat });
  }
  return { code: created.room.code, host, hostSeat: created, others };
}

/** Starts a round as host and picks the first word; returns the secret word. */
async function startDrawing(host: Client): Promise<{ word: string; roundId: number }> {
  const choices = waitFor<PrivateRoundInfo>(host, 'round:private', (p) => p.choices !== null);
  ok(await emitRaw(host, 'game:start'));
  const info = await choices;
  const drawing = waitFor<RoomSnapshot>(host, 'room:state', (s) => s.phase === 'drawing');
  ok(await emitRaw(host, 'round:chooseWord', { index: 0 }));
  await drawing;
  return { word: info.choices![0]!, roundId: info.roundId };
}

const begin = (id: number, x = 100, y = 100): DrawOp => ({ t: 'begin', id, tool: 'pen', color: '#1f2333', size: 8, x, y });

describe('game over real sockets', () => {
  it('runs a full round: secret choices, ordered drawing, clearing, guessing, reveal', async () => {
    const { url } = await startApp();
    const { code, host: alice, others } = await room(url, 'Alice', 'Bob', 'Cara');
    const [bob, cara] = [others[0]!.c, others[1]!.c];
    // A second room on the same server must see none of this.
    const other = await room(url, 'Dave', 'Erin');
    const outsiders = [other.host, other.others[0]!.c];

    const choicesPromise = waitFor<PrivateRoundInfo>(alice, 'round:private', (p) => p.choices !== null);
    ok(await emitRaw(alice, 'game:start'));
    const choices = (await choicesPromise).choices!;
    assert.deepEqual([...choices].sort(), [...TEST_WORDS].sort());

    // Guessers may not choose.
    assert.equal(errorCode(await emitRaw(bob, 'round:chooseWord', { index: 0 })), 'NOT_DRAWER');
    ok(await emitRaw(alice, 'round:chooseWord', { index: 1 }));
    const word = choices[1]!;
    const state = await waitFor<RoomSnapshot>(bob, 'room:state', (s) => s.phase === 'drawing');
    assert.equal(state.round?.hint, '_'.repeat(word.length));
    const roundId = state.round!.id;

    // A guesser trying to draw is ignored and nothing is relayed.
    emitNoAck(bob, 'draw:ops', { roundId, ops: [begin(1)] });
    assert.equal(errorCode(await emitRaw(bob, 'draw:clear', { roundId })), 'NOT_DRAWER');

    // The drawer sends many small batches; guessers must receive them complete and in order.
    const sent: number[] = [];
    emitNoAck(alice, 'draw:ops', { roundId, ops: [begin(1)] });
    for (let i = 0; i < 40; i++) {
      const pts = [i * 10, i * 5, i * 10 + 3, i * 5 + 2];
      sent.push(...pts);
      emitNoAck(alice, 'draw:ops', { roundId, ops: [{ t: 'points', id: 1, pts }] });
    }
    emitNoAck(alice, 'draw:ops', { roundId, ops: [{ t: 'end', id: 1 }] });
    // Wait until *each* viewer has the final op; they receive independently.
    for (const viewer of [bob, cara]) {
      const hasEnd = () => received<DrawOpsPayload>(viewer, 'draw:ops').some((p) => p.ops.some((op) => op.t === 'end'));
      if (!hasEnd()) await waitFor<DrawOpsPayload>(viewer, 'draw:ops', (p) => p.ops.some((op) => op.t === 'end'));
    }
    for (const viewer of [bob, cara]) {
      const ops = received<DrawOpsPayload>(viewer, 'draw:ops').flatMap((p) => p.ops);
      assert.deepEqual(ops[0], begin(1), 'first op is the drawer’s begin, not the guesser’s');
      assert.equal(ops.filter((op) => op.t === 'begin').length, 1);
      const pts = ops.flatMap((op) => (op.t === 'points' ? op.pts : []));
      assert.deepEqual(pts, sent, 'points arrive complete and in order');
      assert.equal(ops.at(-1)?.t, 'end');
    }
    assert.equal(received(alice, 'draw:ops').length, 0, 'drawer does not get their own ops echoed');

    const cleared = waitFor<{ roundId: number }>(bob, 'draw:clear');
    ok(await emitRaw(alice, 'draw:clear', { roundId }));
    assert.equal((await cleared).roundId, roundId);

    // Drawer cannot chat; wrong guesses are ordinary chat.
    assert.equal(errorCode(await emitRaw(alice, 'chat:send', { text: 'it rhymes with...' })), 'DRAWER_CANNOT_CHAT');
    const wrong = waitFor<ChatMessage>(cara, 'chat:message', (m) => m.kind === 'chat');
    assert.deepEqual(ok(await emitRaw(bob, 'chat:send', { text: 'is it a horse?' })), { status: 'sent' });
    assert.equal((await wrong).text, 'is it a horse?');

    // Correct guess: everyone hears that Bob got it; only Bob learns the word.
    const bobPrivate = waitFor<PrivateRoundInfo>(bob, 'round:private');
    const caraHears = waitFor<ChatMessage>(cara, 'chat:message', (m) => m.kind === 'correct');
    assert.deepEqual(ok(await emitRaw(bob, 'chat:send', { text: `  ${word.toUpperCase()} ` })), { status: 'correct' });
    assert.equal((await bobPrivate).word, word);
    assert.ok(!(await caraHears).text.includes(word));
    // Repeat answer: no second "correct".
    assert.deepEqual(ok(await emitRaw(bob, 'chat:send', { text: word })), { status: 'sent' });

    // Bob's further chat goes to the drawer and guessed players only.
    const aliceHears = waitFor<ChatMessage>(alice, 'chat:message', (m) => m.text.startsWith('psst'));
    ok(await emitRaw(bob, 'chat:send', { text: `psst it is ${word}` }));
    await aliceHears;
    await sleep(100);

    // Secrecy: nothing Cara has received so far contains the word or the other choices.
    const caraSoFar = JSON.stringify(cara.events);
    for (const w of TEST_WORDS) assert.ok(!caraSoFar.includes(w), `Cara saw "${w}" before guessing`);
    assert.equal(received<ChatMessage>(bob, 'chat:message').filter((m) => m.kind === 'correct').length, 1);

    const ended = waitFor<RoomSnapshot>(cara, 'room:state', (s) => s.phase === 'round-end');
    assert.deepEqual(ok(await emitRaw(cara, 'chat:send', { text: word })), { status: 'correct' });
    const end = await ended;
    assert.equal(end.round?.endReason, 'all-guessed');
    assert.equal(end.round?.word, word);
    assert.deepEqual(end.round?.guessedIds, [others[0]!.seat.playerId, others[1]!.seat.playerId]);

    // Cross-room isolation.
    for (const outsider of outsiders) {
      const leaked = outsider.events.filter((e) => ['draw:ops', 'draw:clear', 'round:private', 'chat:message'].includes(e.event));
      assert.deepEqual(leaked, [], 'other room received events');
      assert.ok(received<RoomSnapshot>(outsider, 'room:state').every((s) => s.code !== code));
    }

    // Next test round rotates to Bob.
    const next = waitFor<RoomSnapshot>(bob, 'room:state', (s) => s.phase === 'choosing');
    assert.equal(errorCode(await emitRaw(bob, 'round:next')), 'NOT_HOST');
    ok(await emitRaw(alice, 'round:next'));
    assert.equal((await next).round?.drawerId, others[0]!.seat.playerId);
  });

  it('auto-picks a word and ends the round when the timer expires', async () => {
    const { url } = await startApp({ wordChoiceMs: 1000, drawTimeMs: 1000 });
    const { host, others } = await room(url, 'Alice', 'Bob');
    const bob = others[0]!.c;
    const drawing = waitFor<RoomSnapshot>(bob, 'room:state', (s) => s.phase === 'drawing', 3000);
    ok(await emitRaw(host, 'game:start'));
    const d = await drawing;
    assert.ok(d.round!.remainingMs! > 800 && d.round!.remainingMs! <= 1000);
    const ended = await waitFor<RoomSnapshot>(bob, 'room:state', (s) => s.phase === 'round-end', 3000);
    assert.equal(ended.round?.endReason, 'timeout');
    assert.ok(TEST_WORDS.includes(ended.round!.word!));
  });

  it('restores the drawing and private state for reconnecting players', async () => {
    const { url } = await startApp();
    const { code, host: alice, hostSeat, others } = await room(url, 'Alice', 'Bob', 'Cara');
    const bobSeat = others[0]!.seat;
    const { word, roundId } = await startDrawing(alice);
    emitNoAck(alice, 'draw:ops', { roundId, ops: [begin(1), { t: 'points', id: 1, pts: [200, 200, 300, 300] }, { t: 'end', id: 1 }] });
    emitNoAck(alice, 'draw:ops', { roundId, ops: [begin(2, 50, 60)] });
    await waitFor<DrawOpsPayload>(others[0]!.c, 'draw:ops', (p) => p.ops.some((op) => op.t === 'begin' && op.id === 2));

    // Guesser reconnects: gets strokes (including the open one), no word.
    others[0]!.c.disconnect();
    const bob2 = await client(url);
    const bobBack = ok(await emitRaw<JoinedRoom>(bob2, 'room:rejoin', { code, sessionToken: bobSeat.sessionToken }));
    assert.equal(bobBack.room.phase, 'drawing');
    assert.deepEqual(
      bobBack.game?.strokes.map((s) => [s.id, s.pts, s.done]),
      [
        [1, [100, 100, 200, 200, 300, 300], true],
        [2, [50, 60], false],
      ],
    );
    assert.equal(bobBack.game?.privateRound, null);
    assert.ok(!JSON.stringify(bobBack).includes(word));

    // Drawer reconnects on a new socket: gets the word back and can keep drawing; the old socket can't.
    const alice2 = await client(url);
    const replaced = waitFor(alice, 'session:replaced');
    const aliceBack = ok(await emitRaw<JoinedRoom>(alice2, 'room:rejoin', { code, sessionToken: hostSeat.sessionToken }));
    await replaced;
    assert.equal(aliceBack.game?.privateRound?.word, word);
    assert.equal(aliceBack.game?.strokes.length, 2);

    emitNoAck(alice, 'draw:ops', { roundId, ops: [begin(50)] });
    emitNoAck(alice2, 'draw:ops', { roundId, ops: [begin(3)] });
    const relayed = await waitFor<DrawOpsPayload>(bob2, 'draw:ops');
    assert.deepEqual(relayed.ops, [begin(3)], 'only the current drawer socket is relayed');

    // Bob guesses after reconnecting; his next rejoin includes the word.
    ok(await emitRaw(bob2, 'chat:send', { text: word }));
    bob2.disconnect();
    const bob3 = await client(url);
    const bobAgain = ok(await emitRaw<JoinedRoom>(bob3, 'room:rejoin', { code, sessionToken: bobSeat.sessionToken }));
    assert.equal(bobAgain.game?.privateRound?.word, word);
  });

  it('rate-limits chat and drawing and survives malformed payloads', async () => {
    const { url, app } = await startApp();
    const { host: alice, others } = await room(url, 'Alice', 'Bob', 'Cara');
    const [bob, cara] = [others[0]!.c, others[1]!.c];
    const { roundId } = await startDrawing(alice);

    const results = [];
    for (let i = 0; i < 6; i++) results.push(await emitRaw(bob, 'chat:send', { text: `guess ${i}` }));
    assert.deepEqual(results.map(errorCode), [undefined, undefined, undefined, undefined, undefined, 'RATE_LIMITED']);

    // Flood: 150 batches at once; at most 100 per 2s get through.
    emitNoAck(alice, 'draw:ops', { roundId, ops: [begin(1)] });
    for (let i = 0; i < 150; i++) emitNoAck(alice, 'draw:ops', { roundId, ops: [{ t: 'points', id: 1, pts: [i, i] }] });
    await sleep(300);
    const batches = received<DrawOpsPayload>(bob, 'draw:ops').length;
    assert.ok(batches <= 100 && batches >= 90, `expected ~100 batches through, got ${batches}`);

    for (const payload of [null, 'x', 42, [], { roundId }, { roundId, ops: 'nope' }, { roundId, ops: [{ t: 'begin' }] }]) {
      emitNoAck(alice, 'draw:ops', payload);
    }
    // Cara has her own chat budget (5 per 5s); each malformed message still counts against it.
    for (const payload of [null, {}, { text: 5 }, { text: '' }, { text: 'y'.repeat(500) }]) {
      const code = errorCode(await emitRaw(cara, 'chat:send', payload));
      assert.ok(code === 'INVALID_PAYLOAD' || code === 'INVALID_MESSAGE', `chat ${JSON.stringify(payload)} → ${code}`);
    }
    assert.equal(errorCode(await emitRaw(alice, 'round:chooseWord', { index: '0' })), 'INVALID_PHASE');
    assert.equal(errorCode(await emitRaw(alice, 'draw:clear', 'nope')), 'INVALID_PAYLOAD');
    assert.equal(errorCode(await emitRaw(alice, 'draw:clear', { roundId: 'x' })), 'INVALID_PHASE');

    await sleep(2100); // let the drawing window reset
    // Still healthy and still relaying valid drawing.
    const health = (await (await fetch(`${url}/api/health`)).json()) as { status: string };
    assert.equal(health.status, 'ok');
    const relayed = waitFor<DrawOpsPayload>(bob, 'draw:ops', (p) => p.ops[0]?.id === 2);
    emitNoAck(alice, 'draw:ops', { roundId, ops: [begin(2)] });
    await relayed;
    assert.ok(app.rooms.roomCount >= 1);
  });

  it('ends the round for everyone when the drawer leaves', async () => {
    const { url } = await startApp();
    const { host: alice, others } = await room(url, 'Alice', 'Bob', 'Cara');
    await startDrawing(alice);
    const ended = waitFor<RoomSnapshot>(others[1]!.c, 'room:state', (s) => s.phase === 'round-end');
    ok(await emitRaw(alice, 'room:leave'));
    const end = await ended;
    assert.equal(end.round?.endReason, 'drawer-left');
    assert.ok(TEST_WORDS.includes(end.round!.word!));
  });
});
