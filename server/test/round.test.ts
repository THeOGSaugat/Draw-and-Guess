import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DRAW_LIMITS, type ChatMessage, type DrawOp } from '@draw-guess/shared';
import { parseDrawOps } from '../src/game/drawing.js';
import { isCorrectGuess, maskWord } from '../src/game/guess.js';
import { pickWords, WORDS } from '../src/game/words.js';
import { RoomError } from '../src/rooms/RoomError.js';
import { RoomManager, type RoomManagerOptions } from '../src/rooms/RoomManager.js';

// Distinctive words so "never appears in JSON" checks can't match by accident.
const TEST_WORDS = ['zebracorn', 'quokkaship', 'yetibanjo'];

interface Captured {
  changed: string[];
  privates: { code: string; playerId: string }[];
  chats: { message: ChatMessage; audience: string[] | null }[];
}

const managers: RoomManager[] = [];
function setup(overrides: Partial<RoomManagerOptions> = {}) {
  const captured: Captured = { changed: [], privates: [], chats: [] };
  const m = new RoomManager({
    maxPlayersPerRoom: 8,
    maxRooms: 100,
    reconnectGraceMs: 1000,
    hostHandoffMs: 1000,
    wordChoiceMs: 5000,
    drawTimeMs: 5000,
    roundResultsMs: 5000,
    words: TEST_WORDS,
    onRoomChanged: (code) => captured.changed.push(code),
    onPrivateRound: (code, playerId) => captured.privates.push({ code, playerId }),
    onChat: (_code, message, audience) => captured.chats.push({ message, audience }),
    ...overrides,
  });
  managers.push(m);
  return { m, captured };
}
afterEach(() => managers.splice(0).forEach((m) => m.dispose()));

function assertRoomError(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof RoomError && err.code === code, `expected ${code}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Room with host Alice (first drawer), Bob and Cara, already in the drawing phase. */
function drawingRoom(overrides: Partial<RoomManagerOptions> = {}) {
  const ctx = setup(overrides);
  const { m } = ctx;
  const { room, player: alice } = m.createRoom('Alice', 'sa');
  const { player: bob } = m.joinRoom(room.code, 'Bob', 'sb');
  const { player: cara } = m.joinRoom(room.code, 'Cara', 'sc');
  m.startGame(room.code, alice.id);
  m.chooseWord(room.code, alice.id, 0);
  const word = room.round!.word!;
  return { ...ctx, room, alice, bob, cara, word };
}

describe('round state machine', () => {
  it('starts in choosing with the first player drawing and choices sent only to the drawer', () => {
    const { m, captured } = setup();
    const { room, player: alice } = m.createRoom('Alice', 'sa');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 'sb');
    m.startGame(room.code, alice.id);

    assert.equal(room.phase, 'choosing');
    assert.equal(room.round?.drawerId, alice.id);
    assert.equal(new Set(room.round?.choices).size, 3);
    assert.deepEqual(captured.privates, [{ code: room.code, playerId: alice.id }]);
    assert.deepEqual(m.privateRoundFor(room, alice.id)?.choices, room.round?.choices);
    assert.equal(m.privateRoundFor(room, bob.id), null);

    const publicJson = JSON.stringify(m.toSnapshot(room)) + JSON.stringify(m.gameRestoreFor(room, bob.id));
    for (const word of TEST_WORDS) assert.ok(!publicJson.includes(word), `public state leaked "${word}"`);
  });

  it('validates word choice: drawer only, choosing phase only, valid index only', () => {
    const { m } = setup();
    const { room, player: alice } = m.createRoom('Alice', 'sa');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 'sb');
    assertRoomError(() => m.chooseWord(room.code, alice.id, 0), 'INVALID_PHASE');
    m.startGame(room.code, alice.id);
    assertRoomError(() => m.chooseWord(room.code, bob.id, 0), 'NOT_DRAWER');
    for (const bad of [3, -1, 1.5, '0', null, undefined]) {
      assertRoomError(() => m.chooseWord(room.code, alice.id, bad), 'INVALID_PAYLOAD');
    }
    m.chooseWord(room.code, alice.id, 2);
    assert.equal(room.phase, 'drawing');
    assert.equal(room.round?.word, room.round?.choices[2]);
    assertRoomError(() => m.chooseWord(room.code, alice.id, 0), 'INVALID_PHASE');
    assertRoomError(() => m.nextRound(room.code, alice.id), 'INVALID_PHASE');
  });

  it('shows only a masked hint while drawing and reveals the word at round end', () => {
    const { m, room, alice, bob, cara, word } = drawingRoom();
    const snap = m.toSnapshot(room);
    assert.equal(snap.round?.hint, maskWord(word));
    assert.equal(snap.round?.word, null);
    assert.ok(!JSON.stringify(snap).includes(word));
    assert.equal(m.privateRoundFor(room, alice.id)?.word, word);
    assert.equal(m.privateRoundFor(room, bob.id), null);

    m.sendChat(room.code, bob.id, word);
    m.sendChat(room.code, cara.id, word);
    assert.equal(room.phase, 'round-end');
    const ended = m.toSnapshot(room);
    assert.equal(ended.round?.word, word);
    assert.equal(ended.round?.hint, null);
  });

  it('auto-picks a word when the drawer does not choose in time', async () => {
    const { m, captured } = setup({ wordChoiceMs: 20 });
    const { room, player: alice } = m.createRoom('Alice', 'sa');
    m.joinRoom(room.code, 'Bob', 'sb');
    m.startGame(room.code, alice.id);
    await sleep(60);
    assert.equal(room.phase, 'drawing');
    assert.ok(room.round!.choices.includes(room.round!.word!));
    assert.ok(captured.changed.includes(room.code), 'timer transitions must notify');
  });

  it('ends the round when the drawing timer expires', async () => {
    const { m, room, captured } = drawingRoom({ drawTimeMs: 30 });
    captured.changed.length = 0;
    await sleep(80);
    assert.equal(room.phase, 'round-end');
    assert.equal(room.round?.endReason, 'timeout');
    assert.deepEqual(captured.changed, [room.code]);
    assert.equal(m.toSnapshot(room).round?.remainingMs, null);
  });

  it('rotates the drawer fairly in join order and skips disconnected players', () => {
    const { m } = setup();
    const { room, player: alice } = m.createRoom('Alice', 'sa');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 'sb');
    const { player: cara } = m.joinRoom(room.code, 'Cara', 'sc');
    const drawers: string[] = [];
    const playRound = () => {
      if (room.phase === 'lobby') m.startGame(room.code, room.hostId);
      else m.nextRound(room.code, room.hostId);
      drawers.push(room.round!.drawerId);
      m.chooseWord(room.code, room.round!.drawerId, 0);
      // Everyone else guesses → round ends.
      for (const p of room.players.values()) {
        if (p.id !== room.round!.drawerId && p.socketId) m.sendChat(room.code, p.id, room.round!.word!);
      }
      assert.equal(room.phase, 'round-end');
    };
    playRound();
    playRound();
    playRound();
    playRound();
    assert.deepEqual(drawers, [alice.id, bob.id, cara.id, alice.id]);

    m.markDisconnected(room.code, bob.id, 'sb');
    playRound();
    assert.equal(drawers.at(-1), cara.id, 'disconnected Bob is skipped');
  });

  it('only the host can start, advance, or end; start needs 2 connected players', () => {
    const { m } = setup();
    const { room, player: alice } = m.createRoom('Alice', 'sa');
    assertRoomError(() => m.startGame(room.code, alice.id), 'NOT_ENOUGH_PLAYERS');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 'sb');
    m.markDisconnected(room.code, bob.id, 'sb');
    assertRoomError(() => m.startGame(room.code, alice.id), 'NOT_ENOUGH_PLAYERS');
    m.rejoinRoom(room.code, bob.sessionToken, 'sb2');
    assertRoomError(() => m.startGame(room.code, bob.id), 'NOT_HOST');
    m.startGame(room.code, alice.id);
    assertRoomError(() => m.returnToLobby(room.code, bob.id), 'NOT_HOST');
  });

  it('returning to the lobby cancels the round and its timer', async () => {
    const { m, room, alice, captured } = drawingRoom({ drawTimeMs: 30 });
    m.returnToLobby(room.code, alice.id);
    captured.changed.length = 0;
    await sleep(80);
    assert.equal(room.phase, 'lobby');
    assert.equal(room.round, null);
    assert.equal(m.toSnapshot(room).round, null);
    assert.deepEqual(captured.changed, [], 'cancelled timer must not fire');
  });
});

describe('guessing and chat', () => {
  it('accepts correct guesses ignoring case and surrounding whitespace', () => {
    assert.ok(isCorrectGuess('  ICE   Cream ', 'ice cream'));
    assert.ok(isCorrectGuess('ice-cream', 'ice cream'));
    assert.ok(!isCorrectGuess('ice', 'ice cream'));
    assert.equal(maskWord('ice cream'), '___ _____');
  });

  it('broadcasts wrong guesses as chat and correct guesses as a word-free event', () => {
    const { m, room, bob, captured, word } = drawingRoom();
    captured.chats.length = 0;
    captured.privates.length = 0;

    assert.deepEqual(m.sendChat(room.code, bob.id, 'is it a dog?'), { status: 'sent' });
    assert.equal(captured.chats.at(-1)?.message.kind, 'chat');
    assert.equal(captured.chats.at(-1)?.audience, null);

    assert.deepEqual(m.sendChat(room.code, bob.id, `  ${word.toUpperCase()}  `), { status: 'correct' });
    const correct = captured.chats.at(-1)!;
    assert.equal(correct.message.kind, 'correct');
    assert.ok(!correct.message.text.includes(word), 'correct-guess event must not contain the word');
    assert.deepEqual(captured.privates, [{ code: room.code, playerId: bob.id }]);
    assert.equal(m.privateRoundFor(room, bob.id)?.word, word);
  });

  it('never counts the same player twice and keeps their later messages private', () => {
    const { m, room, alice, bob, captured, word } = drawingRoom();
    m.sendChat(room.code, bob.id, word);
    const before = captured.chats.length;
    assert.deepEqual(m.sendChat(room.code, bob.id, word), { status: 'sent' });
    assert.equal(captured.chats.length, before, 'repeat answer is swallowed');
    assert.deepEqual(room.round!.guessed, [bob.id]);

    m.sendChat(room.code, bob.id, 'that was easy');
    const last = captured.chats.at(-1)!;
    assert.equal(last.message.scope, 'guessed');
    assert.deepEqual(last.audience, [alice.id, bob.id]);
  });

  it('ends the round once every connected guesser has guessed', () => {
    const { m, room, bob, cara, word } = drawingRoom();
    m.sendChat(room.code, bob.id, word);
    assert.equal(room.phase, 'drawing');
    m.sendChat(room.code, cara.id, word);
    assert.equal(room.phase, 'round-end');
    assert.equal(room.round?.endReason, 'all-guessed');
  });

  it('does not wait for disconnected guessers', () => {
    const { m, room, bob, cara, word } = drawingRoom();
    m.sendChat(room.code, bob.id, word);
    m.markDisconnected(room.code, cara.id, 'sc');
    assert.equal(room.phase, 'round-end');
    assert.equal(room.round?.endReason, 'all-guessed');
  });

  it('withholds messages that contain the answer from players who have not guessed', () => {
    const { m, room, alice, bob, cara, word, captured } = drawingRoom();
    captured.chats.length = 0;
    assert.deepEqual(m.sendChat(room.code, bob.id, `maybe ${word.toUpperCase()}s?`), { status: 'sent' });
    assert.equal(room.round!.guessed.length, 0, 'not an exact guess: no points');
    const deliveries = captured.chats.map((c) => [c.message.scope, c.audience, c.message.withheld ?? false]);
    assert.deepEqual(deliveries, [
      ['guessed', [alice.id], true], // drawer (and players who guessed) see it marked as withheld
      ['all', [bob.id], false], // the sender sees it like any other message: no "you were close" hint
    ]);
    assert.ok(!JSON.stringify(m.gameRestoreFor(room, cara.id)).includes(word), 'not in Cara’s history either');
    // Ordinary messages are unaffected.
    m.sendChat(room.code, bob.id, 'is it an animal');
    assert.equal(captured.chats.at(-1)?.audience, null);
  });

  it('rejects drawer chat, empty/oversized/non-string messages', () => {
    const { m, room, alice, bob } = drawingRoom();
    assertRoomError(() => m.sendChat(room.code, alice.id, 'hint hint'), 'DRAWER_CANNOT_CHAT');
    for (const bad of ['', '   ', 'x'.repeat(101), 42, null, { text: 'hi' }]) {
      assertRoomError(() => m.sendChat(room.code, bob.id, bad), 'INVALID_MESSAGE');
    }
    assert.deepEqual(m.sendChat(room.code, bob.id, 'x'.repeat(100)), { status: 'sent' });
    // Control and zero-width characters are stripped.
    m.sendChat(room.code, bob.id, 'he​l\u0007lo');
    assert.equal(room.chat.at(-1)?.text, 'hello');
  });

  it('rejects chat in the lobby but allows it between rounds', () => {
    const { m } = setup();
    const { room, player: alice } = m.createRoom('Alice', 'sa');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 'sb');
    assertRoomError(() => m.sendChat(room.code, bob.id, 'hello?'), 'INVALID_PHASE');
    m.startGame(room.code, alice.id);
    assert.deepEqual(m.sendChat(room.code, bob.id, 'hello!'), { status: 'sent' });
  });

  it('chat history for a rejoining guesser excludes messages only guessed players may see', () => {
    const { m, room, bob, cara, word } = drawingRoom();
    m.sendChat(room.code, bob.id, word);
    m.sendChat(room.code, bob.id, `the answer is ${word}`);
    const restore = m.gameRestoreFor(room, cara.id)!;
    assert.ok(!JSON.stringify(restore).includes(word));
    assert.equal(restore.privateRound, null);
    assert.ok(JSON.stringify(m.gameRestoreFor(room, bob.id)).includes(word));
  });
});

describe('players leaving mid-round', () => {
  it('ends the round when the drawer leaves', () => {
    const { m, room, alice } = drawingRoom();
    m.removePlayer(room.code, alice.id);
    assert.equal(room.phase, 'round-end');
    assert.equal(room.round?.endReason, 'drawer-left');
  });

  it('keeps the round going through a brief drawer disconnect', () => {
    const { m, room, alice } = drawingRoom();
    m.markDisconnected(room.code, alice.id, 'sa');
    assert.equal(room.phase, 'drawing');
    m.rejoinRoom(room.code, alice.sessionToken, 'sa2');
    assert.equal(m.privateRoundFor(room, alice.id)?.word, room.round?.word);
  });

  it('ends the round when too few players remain', () => {
    const { m } = setup();
    const { room, player: alice } = m.createRoom('Alice', 'sa');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 'sb');
    m.startGame(room.code, alice.id);
    m.removePlayer(room.code, bob.id);
    assert.equal(room.phase, 'round-end');
    assert.equal(room.round?.endReason, 'not-enough-players');
    assertRoomError(() => m.nextRound(room.code, alice.id), 'NOT_ENOUGH_PLAYERS');
  });

  it('ends the round when a non-guessing straggler leaves after everyone else guessed', () => {
    const { m, room, bob, cara, word } = drawingRoom();
    m.sendChat(room.code, bob.id, word);
    m.removePlayer(room.code, cara.id);
    assert.equal(room.round?.endReason, 'all-guessed');
  });

  it('clears round timers when the last player leaves', async () => {
    const { m, room, alice, bob, cara, captured } = drawingRoom({ drawTimeMs: 30 });
    for (const p of [bob, cara, alice]) m.removePlayer(room.code, p.id);
    captured.changed.length = 0;
    await sleep(80);
    assert.equal(m.getRoom(room.code), undefined);
    assert.deepEqual(captured.changed, []);
  });
});

describe('drawing', () => {
  const begin = (id: number, extra: Partial<DrawOp> = {}): DrawOp =>
    ({ t: 'begin', id, tool: 'pen', color: '#1f2333', size: 8, x: 10, y: 10, ...extra }) as DrawOp;

  it('only the drawer, on their current socket, in the current round, may draw', () => {
    const { m, room, alice, bob } = drawingRoom();
    const roundId = room.round!.id;
    assertRoomError(() => m.applyDrawOps(room.code, bob.id, 'sb', { roundId, ops: [begin(1)] }), 'NOT_DRAWER');
    assertRoomError(() => m.applyDrawOps(room.code, alice.id, 'stale-socket', { roundId, ops: [begin(1)] }), 'NOT_DRAWER');
    assertRoomError(() => m.applyDrawOps(room.code, alice.id, 'sa', { roundId: roundId + 1, ops: [begin(1)] }), 'INVALID_PHASE');
    assert.equal(m.applyDrawOps(room.code, alice.id, 'sa', { roundId, ops: [begin(1)] }).length, 1);
    assertRoomError(() => m.clearCanvas(room.code, bob.id, 'sb', roundId), 'NOT_DRAWER');
  });

  it('rejects drawing outside the drawing phase', () => {
    const { m } = setup();
    const { room, player: alice } = m.createRoom('Alice', 'sa');
    m.joinRoom(room.code, 'Bob', 'sb');
    m.startGame(room.code, alice.id);
    assertRoomError(() => m.applyDrawOps(room.code, alice.id, 'sa', { roundId: room.round!.id, ops: [begin(1)] }), 'INVALID_PHASE');
  });

  it('keeps stroke order and ignores out-of-order or mismatched ops', () => {
    const { m, room, alice } = drawingRoom();
    const roundId = room.round!.id;
    const accepted = m.applyDrawOps(room.code, alice.id, 'sa', {
      roundId,
      ops: [
        begin(1),
        { t: 'points', id: 1, pts: [20, 20, 30, 30] },
        { t: 'points', id: 9, pts: [1, 1] }, // not the open stroke
        { t: 'end', id: 1 },
        begin(1), // id must increase
        begin(2),
        { t: 'points', id: 2, pts: [5, 5] },
      ],
    });
    assert.deepEqual(
      accepted.map((op) => `${op.t}:${op.id}`),
      ['begin:1', 'points:1', 'end:1', 'begin:2', 'points:2'],
    );
    const strokes = room.round!.drawing.strokes;
    assert.deepEqual(strokes.map((s) => [s.id, s.pts, s.done]), [
      [1, [10, 10, 20, 20, 30, 30], true],
      [2, [10, 10, 5, 5], false],
    ]);
  });

  it('clearing empties the canvas but stroke ids keep increasing', () => {
    const { m, room, alice } = drawingRoom();
    const roundId = room.round!.id;
    m.applyDrawOps(room.code, alice.id, 'sa', { roundId, ops: [begin(1), { t: 'end', id: 1 }] });
    m.clearCanvas(room.code, alice.id, 'sa', roundId);
    assert.equal(room.round!.drawing.strokes.length, 0);
    assert.equal(m.applyDrawOps(room.code, alice.id, 'sa', { roundId, ops: [begin(1)] }).length, 0);
    assert.equal(m.applyDrawOps(room.code, alice.id, 'sa', { roundId, ops: [begin(2)] }).length, 1);
    assert.equal(m.gameRestoreFor(room, alice.id)!.strokes.length, 1);
  });

  it('tells a rejoining drawer which stroke id to continue from, even after a clear', () => {
    const { m, room, alice } = drawingRoom();
    const roundId = room.round!.id;
    m.applyDrawOps(room.code, alice.id, 'sa', { roundId, ops: [begin(1), begin(2), begin(3)] });
    m.clearCanvas(room.code, alice.id, 'sa', roundId);
    m.markDisconnected(room.code, alice.id, 'sa');
    m.rejoinRoom(room.code, alice.sessionToken, 'sa2');
    const restore = m.gameRestoreFor(room, alice.id)!;
    assert.equal(restore.strokes.length, 0);
    const next = restore.privateRound!.nextStrokeId!;
    assert.equal(next, 4);
    assert.equal(m.applyDrawOps(room.code, alice.id, 'sa2', { roundId, ops: [begin(next)] }).length, 1);
  });

  it('caps points per stroke', () => {
    const { m, room, alice } = drawingRoom();
    const roundId = room.round!.id;
    m.applyDrawOps(room.code, alice.id, 'sa', { roundId, ops: [begin(1)] });
    const batch = Array.from({ length: DRAW_LIMITS.pointsPerOp * 2 }, (_, i) => i % 2000);
    let total = 1;
    for (let i = 0; i < 20; i++) {
      for (const op of m.applyDrawOps(room.code, alice.id, 'sa', { roundId, ops: [{ t: 'points', id: 1, pts: batch }] })) {
        if (op.t === 'points') total += op.pts.length / 2;
      }
    }
    assert.equal(total, DRAW_LIMITS.pointsPerStroke);
    assert.equal(room.round!.drawing.strokes[0]!.pts.length / 2, DRAW_LIMITS.pointsPerStroke);
  });

  it('rejects malformed draw payloads and strips unknown fields', () => {
    const bad: unknown[] = [
      null,
      'ops',
      [],
      { roundId: 1 },
      { roundId: '1', ops: [begin(1)] },
      { roundId: 1, ops: [] },
      { roundId: 1, ops: Array.from({ length: DRAW_LIMITS.opsPerBatch + 1 }, (_, i) => begin(i + 1)) },
      { roundId: 1, ops: [{ t: 'begin', id: 1, tool: 'laser', color: '#1f2333', size: 8, x: 0, y: 0 }] },
      { roundId: 1, ops: [begin(1, { color: '#123456' })] },
      { roundId: 1, ops: [begin(1, { size: 9 })] },
      { roundId: 1, ops: [begin(1, { x: 2001 })] },
      { roundId: 1, ops: [begin(1, { x: -1 })] },
      { roundId: 1, ops: [begin(1, { x: 1.5 })] },
      { roundId: 1, ops: [begin(0)] },
      { roundId: 1, ops: [{ t: 'points', id: 1, pts: [1, 2, 3] }] },
      { roundId: 1, ops: [{ t: 'points', id: 1, pts: ['1', '2'] }] },
      { roundId: 1, ops: [{ t: 'points', id: 1, pts: Array(DRAW_LIMITS.pointsPerOp * 2 + 2).fill(1) }] },
      { roundId: 1, ops: [{ t: 'undo', id: 1 }] },
      { roundId: 1, ops: [begin(1), 'junk'] },
    ];
    for (const payload of bad) {
      assert.throws(() => parseDrawOps(payload), RoomError, `should reject ${JSON.stringify(payload)?.slice(0, 80)}`);
    }
    const parsed = parseDrawOps({
      roundId: 1,
      ops: [{ ...begin(1, { tool: 'eraser', color: 'anything' }), extra: '<script>' }],
    });
    assert.deepEqual(parsed.ops[0], { t: 'begin', id: 1, tool: 'eraser', color: '#ffffff', size: 8, x: 10, y: 10 });
  });
});

describe('word list', () => {
  it('is lowercase, unique, and picks distinct unused words', () => {
    assert.equal(new Set(WORDS).size, WORDS.length);
    assert.ok(WORDS.every((w) => /^[a-z]+( [a-z]+)?$/.test(w)), 'words are lowercase ASCII');
    const picked = pickWords(3, new Set(WORDS.slice(3)));
    assert.deepEqual(new Set(picked), new Set(WORDS.slice(0, 3)));
    assert.equal(pickWords(3, new Set(WORDS)).length, 3, 'falls back when everything was used');
  });
});
