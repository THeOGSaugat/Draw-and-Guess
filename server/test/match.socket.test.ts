import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import {
  MATCH_ROUNDS,
  SCORING,
  type AckResult,
  type ChatMessage,
  type ClientToServerEvents,
  type JoinedRoom,
  type PrivateRoundInfo,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@draw-guess/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { createApp, type AppInstance } from '../src/createApp.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { events: { event: string; args: unknown[] }[] };

// Enough distinctive words that no word repeats within a match.
const TEST_WORDS = Array.from({ length: 15 }, (_, i) => `zq${String.fromCharCode(97 + i)}word${i}x`);

const apps: AppInstance[] = [];
const clients: Client[] = [];

async function startApp(overrides: { roundResultsMs?: number; drawTimeMs?: number } = {}) {
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

async function client(url: string): Promise<Client> {
  const c = connect(url, { transports: ['websocket'], forceNew: true }) as Client;
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
function ok<T>(result: AckResult<T>): T {
  if (!result.ok) assert.fail(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.data;
}
const errorCode = (r: AckResult<unknown>) => (r.ok ? undefined : r.error.code);

function waitFor<T>(c: Client, event: string, match: (arg: T) => boolean = () => true, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const off = () => (c.off as (e: string, l: unknown) => void)(event, listener);
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (arg: T) => {
      if (!match(arg)) return;
      clearTimeout(timer);
      off();
      resolve(arg);
    };
    (c.on as (e: string, l: unknown) => void)(event, listener);
  });
}

/** An event already received (from the recorded log) or the next one that matches. */
function receivedOrNext<T>(c: Client, event: string, match: (arg: T) => boolean, timeoutMs = 3000): Promise<T> {
  const seen = c.events.find((e) => e.event === event && match(e.args[0] as T));
  return seen ? Promise.resolve(seen.args[0] as T) : waitFor(c, event, match, timeoutMs);
}

async function room(url: string, ...names: string[]) {
  const players: { name: string; c: Client; seat: JoinedRoom }[] = [];
  const host = await client(url);
  const created = ok(await emitRaw<JoinedRoom>(host, 'room:create', { nickname: names[0] }));
  players.push({ name: names[0]!, c: host, seat: created });
  for (const name of names.slice(1)) {
    const c = await client(url);
    players.push({ name, c, seat: ok(await emitRaw<JoinedRoom>(c, 'room:join', { code: created.room.code, nickname: name })) });
  }
  return { code: created.room.code, players, byId: (id: string) => players.find((p) => p.seat.playerId === id)! };
}

describe('five-round match over real sockets', () => {
  it('plays a full match: server scoring, rotation, results, final standings, privacy, rematch', async () => {
    const { url } = await startApp({ drawTimeMs: 2000 });
    const { players, byId } = await room(url, 'Alice', 'Bob', 'Cara', 'Lurker');
    const [alice, bob, cara, lurker] = players as [typeof players[0], typeof players[0], typeof players[0], typeof players[0]];
    const expected = new Map(players.map((p) => [p.seat.playerId, 0]));
    const wordsByRound = new Map<number, string>();
    /** Rounds where Lurker drew, so legitimately knew the word. */
    const lurkerDrew = new Set<string>();
    const drawers: string[] = [];

    const firstRound = waitFor<RoomSnapshot>(lurker.c, 'room:state', (s) => s.phase === 'choosing');
    ok(await emitRaw(alice.c, 'game:start'));
    let state = await firstRound;

    for (let n = 1; n <= MATCH_ROUNDS; n++) {
      assert.equal(state.round?.number, n);
      assert.equal(state.match?.roundNumber, n);
      assert.equal(state.match?.totalRounds, MATCH_ROUNDS);
      const drawer = byId(state.round!.drawerId);
      drawers.push(drawer.name);

      const roundId = state.round!.id;
      const choices = (
        await receivedOrNext<PrivateRoundInfo>(drawer.c, 'round:private', (p) => p.roundId === roundId && p.choices !== null)
      ).choices!;
      const drawing = waitFor<RoomSnapshot>(lurker.c, 'room:state', (s) => s.phase === 'drawing' && s.round!.number === n);
      ok(await emitRaw(drawer.c, 'round:chooseWord', { index: 0 }));
      await drawing;
      const word = choices[0]!;
      wordsByRound.set(state.round!.id, word);
      if (drawer === lurker) lurkerDrew.add(word);

      // Everyone except the drawer and Lurker guesses at once; the server decides the order.
      const guessers = [alice, bob, cara].filter((p) => p !== drawer);
      const ended = waitFor<RoomSnapshot>(lurker.c, 'room:state', (s) => s.phase === 'round-end' && s.round!.number === n, 7000);
      const results = await Promise.all(guessers.map((g) => emitRaw(g.c, 'chat:send', { text: word })));
      assert.deepEqual(results.map((r) => ok(r)), guessers.map(() => ({ status: 'correct' })));
      if (drawer !== lurker) {
        // A repeat never scores. (When Lurker draws, the round already ended: everyone guessed.)
        assert.deepEqual(ok(await emitRaw(guessers[0]!.c, 'chat:send', { text: word })), { status: 'sent' });
      }

      // With Lurker guessing, the round ends on the 5s timer; when Lurker draws, everyone guessed.
      const end = await ended;
      const result = end.match!.lastResult!;
      assert.equal(result.word, word);
      assert.equal(result.drawerNickname, drawer.name);
      assert.equal(end.round!.endReason, drawer === lurker ? 'all-guessed' : 'timeout');

      // Expected points come from the server's own "correct" announcements (order + speed),
      // then cross-checked against the per-round results and totals.
      const announcements = lurker.c.events
        .filter((e) => e.event === 'chat:message')
        .map((e) => e.args[0] as ChatMessage)
        .filter((m) => m.kind === 'correct')
        .slice(-guessers.length);
      assert.equal(announcements.length, guessers.length);
      for (let i = 0; i < announcements.length; i++) {
        const pts = announcements[i]!.points!;
        assert.ok(pts <= 100 && pts >= SCORING.guessBaseMin, `points in range: ${pts}`);
        if (i > 0) assert.ok(pts < announcements[i - 1]!.points!, 'an earlier correct guess scores more');
      }
      for (const a of announcements) expected.set(a.playerId!, expected.get(a.playerId!)! + a.points!);
      const drawerPoints = guessers.length * SCORING.drawerPerGuess;
      expected.set(drawer.seat.playerId, expected.get(drawer.seat.playerId)! + drawerPoints);
      for (const e of result.entries) {
        assert.equal(e.total, expected.get(e.playerId), `round ${n} total for ${e.nickname}`);
        if (e.isDrawer) assert.equal(e.points, drawerPoints);
        if (e.nickname === 'Lurker' && !e.isDrawer) assert.equal(e.points, 0);
      }

      // Duplicate "next" requests: one advances, the other is rejected; never two rounds.
      const label = n < MATCH_ROUNDS ? 'choosing' : 'match-end';
      const advanced = waitFor<RoomSnapshot>(lurker.c, 'room:state', (s) => s.phase === label);
      const [r1, r2] = await Promise.all([emitRaw(alice.c, 'round:next'), emitRaw(alice.c, 'round:next')]);
      assert.deepEqual([errorCode(r1), errorCode(r2)].sort(), [undefined, 'INVALID_PHASE'].sort());
      assert.equal(errorCode(await emitRaw(bob.c, 'round:next')), alice.seat.playerId === bob.seat.playerId ? undefined : 'NOT_HOST');
      state = await advanced;
    }

    // Final standings.
    assert.equal(state.phase, 'match-end');
    assert.equal(state.round, null);
    const standings = state.match!.standings;
    assert.deepEqual(new Map(standings.map((s) => [s.playerId, s.score])), expected);
    for (let i = 1; i < standings.length; i++) assert.ok(standings[i - 1]!.score >= standings[i]!.score);
    // Lurker only ever earned drawer points (3 guessers × 25 in the one round they drew).
    assert.equal(standings.find((s) => s.nickname === 'Lurker')!.score, 3 * SCORING.drawerPerGuess);
    assert.equal(standings.find((s) => s.nickname === 'Lurker')!.roundsGuessed, 0);
    assert.deepEqual(drawers, ['Alice', 'Bob', 'Cara', 'Lurker', 'Alice'], 'everyone draws once before anyone draws twice');
    const top = standings[0]!.score;
    assert.deepEqual(state.match!.winnerIds.sort(), standings.filter((s) => s.score === top).map((s) => s.playerId).sort());

    // Privacy: replay everything the lurker received; no word may appear before its round's reveal.
    // The official reveal is the round-end system message ("… The word was "x".") or the round-end state.
    const revealed = new Set<string>();
    for (const { event, args } of lurker.c.events) {
      if (event === 'chat:message') {
        const m = args[0] as ChatMessage;
        const official = m.kind === 'system' && m.playerId === null ? /The word was "([^"]+)"\.$/.exec(m.text) : null;
        if (official) revealed.add(official[1]!);
      }
      const json = JSON.stringify(args);
      for (const [roundId, word] of wordsByRound) {
        if (!revealed.has(word) && !lurkerDrew.has(word)) assert.ok(!json.includes(word), `lurker saw "${word}" (round ${roundId}) early via ${event}`);
      }
      if (event === 'room:state') {
        const s = args[0] as RoomSnapshot;
        if (s.match?.lastResult?.word) revealed.add(s.match.lastResult.word);
      }
    }
    assert.equal(revealed.size, MATCH_ROUNDS);

    // Forged client events change nothing.
    for (const [event, payload] of [
      ['score:set', { playerId: lurker.seat.playerId, score: 9999 }],
      ['round:end', { reason: 'all-guessed' }],
      ['match:finish', {}],
    ] as const) {
      (lurker.c.emit as (...a: unknown[]) => void)(event, payload, () => {});
    }
    assert.equal(errorCode(await emitRaw(lurker.c, 'match:playAgain')), 'NOT_HOST');
    assert.equal(errorCode(await emitRaw(lurker.c, 'game:start')), 'NOT_HOST');
    ok(await emitRaw(lurker.c, 'chat:send', { text: 'gg', correct: true, points: 9999 }));

    // Play Again twice at once: exactly one fresh match, fully reset.
    const rematch = waitFor<RoomSnapshot>(lurker.c, 'room:state', (s) => s.phase === 'choosing');
    const again = await Promise.all([emitRaw(alice.c, 'match:playAgain'), emitRaw(alice.c, 'match:playAgain')]);
    assert.deepEqual(again.map(errorCode).sort(), [undefined, 'INVALID_PHASE'].sort());
    const fresh = await rematch;
    assert.equal(fresh.match!.id, state.match!.id + 1);
    assert.equal(fresh.match!.roundNumber, 1);
    assert.ok(fresh.match!.standings.every((s) => s.score === 0));
    assert.deepEqual(fresh.round!.guessedIds, []);
    assert.notEqual(byId(fresh.round!.drawerId).name, 'Alice', 'last drawer does not open the rematch');
  });

  it('advances on its own after the results countdown, and Return to Lobby keeps everyone', async () => {
    const { url } = await startApp({ roundResultsMs: 1000 });
    const { players } = await room(url, 'Alice', 'Bob');
    const [alice, bob] = players as [typeof players[0], typeof players[0]];
    const choicesP = waitFor<PrivateRoundInfo>(alice.c, 'round:private', (p) => p.choices !== null);
    ok(await emitRaw(alice.c, 'game:start'));
    const word = (await choicesP).choices![0]!;
    ok(await emitRaw(alice.c, 'round:chooseWord', { index: 0 }));
    const ended = waitFor<RoomSnapshot>(bob.c, 'room:state', (s) => s.phase === 'round-end');
    ok(await emitRaw(bob.c, 'chat:send', { text: word }));
    const end = await ended;
    assert.ok(end.match!.nextInMs! > 0 && end.match!.nextInMs! <= 1000, `countdown ${end.match!.nextInMs}`);
    const round2 = await waitFor<RoomSnapshot>(bob.c, 'room:state', (s) => s.phase === 'choosing', 3000);
    assert.equal(round2.match!.roundNumber, 2);
    assert.equal(round2.round!.drawerId, bob.seat.playerId);

    const lobby = waitFor<RoomSnapshot>(bob.c, 'room:state', (s) => s.phase === 'lobby');
    ok(await emitRaw(alice.c, 'game:returnToLobby'));
    const l = await lobby;
    assert.equal(l.match, null);
    assert.equal(l.players.length, 2);
  });
});
