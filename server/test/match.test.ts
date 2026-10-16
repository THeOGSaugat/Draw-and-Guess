import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { MATCH_ROUNDS, SCORING } from '@draw-guess/shared';
import { pickDrawer } from '../src/game/rotation.js';
import { guessPoints, rankByScore, winnersOf } from '../src/game/scoring.js';
import { RoomError } from '../src/rooms/RoomError.js';
import { RoomManager, type Room, type RoomManagerOptions } from '../src/rooms/RoomManager.js';

// Distinctive words so privacy checks can search raw JSON without false matches.
const TEST_WORDS = ['zebracorn', 'quokkaship', 'yetibanjo', 'walrusoboe', 'narwhalkite', 'pandafridge'];
const DRAW_MS = 60_000;
const RESULTS_MS = 8_000;
const CHOICE_MS = 15_000;

function assertRoomError(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof RoomError && err.code === code, `expected ${code}`);
}

const managers: RoomManager[] = [];
let changed: string[] = [];

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  changed = [];
});
afterEach(() => {
  managers.splice(0).forEach((m) => m.dispose());
  mock.timers.reset();
});

function setup(overrides: Partial<RoomManagerOptions> = {}) {
  const m = new RoomManager({
    maxPlayersPerRoom: 8,
    maxRooms: 100,
    reconnectGraceMs: 30_000,
    hostHandoffMs: 10_000,
    wordChoiceMs: CHOICE_MS,
    drawTimeMs: DRAW_MS,
    roundResultsMs: RESULTS_MS,
    words: TEST_WORDS,
    onRoomChanged: (code) => changed.push(code),
    ...overrides,
  });
  managers.push(m);
  return m;
}

/** Room with the given players (first is host); returns ids by nickname. */
function roomWith(m: RoomManager, ...names: string[]) {
  const [hostName, ...rest] = names;
  const { room, player } = m.createRoom(hostName!, `s-${hostName}`);
  const ids: Record<string, string> = { [hostName!]: player.id };
  const tokens: Record<string, string> = { [hostName!]: player.sessionToken };
  for (const name of rest) {
    const seat = m.joinRoom(room.code, name, `s-${name}`);
    ids[name] = seat.player.id;
    tokens[name] = seat.player.sessionToken;
  }
  const nameOf = (id: string) => Object.keys(ids).find((n) => ids[n] === id)!;
  return { room, ids, tokens, nameOf };
}

const advance = (ms: number) => mock.timers.tick(ms);
const scoreOf = (m: RoomManager, room: Room, id: string) =>
  m.toSnapshot(room).match!.standings.find((s) => s.playerId === id)?.score;

/** Drawer picks the first word; returns it. */
function choose(m: RoomManager, room: Room): string {
  m.chooseWord(room.code, room.round!.drawerId, 0);
  return room.round!.word!;
}

describe('scoring formula', () => {
  it('gives up to 100 points: order-based base plus a speed bonus', () => {
    assert.equal(guessPoints(1, DRAW_MS, DRAW_MS), 100, 'first, instantly');
    assert.equal(guessPoints(1, 0, DRAW_MS), 50, 'first, at the buzzer');
    assert.equal(guessPoints(2, DRAW_MS / 2, DRAW_MS), 40 + 25);
    assert.equal(guessPoints(3, 0, DRAW_MS), 30);
    assert.equal(guessPoints(4, 0, DRAW_MS), 20);
    assert.equal(guessPoints(7, 0, DRAW_MS), SCORING.guessBaseMin, 'base never drops below the minimum');
    assert.equal(guessPoints(1, -500, DRAW_MS), 50, 'negative time left gives no bonus');
    assert.equal(guessPoints(1, DRAW_MS * 2, DRAW_MS), 100, 'bonus is capped');
    for (let order = 1; order <= 8; order++) {
      for (const t of [0, 1, 30_000, DRAW_MS]) assert.ok(guessPoints(order, t, DRAW_MS) <= 100);
      if (order > 1) assert.ok(guessPoints(order, 30_000, DRAW_MS) <= guessPoints(order - 1, 30_000, DRAW_MS));
    }
  });

  it('ranks ties together (1, 1, 3) and only declares winners who scored', () => {
    const ranked = rankByScore([
      { playerId: 'a', score: 10 },
      { playerId: 'b', score: 30 },
      { playerId: 'c', score: 30 },
      { playerId: 'd', score: 0 },
      { playerId: 'e', score: 0 },
    ]);
    assert.deepEqual(
      ranked.map((r) => [r.playerId, r.rank]),
      [['b', 1], ['c', 1], ['a', 3], ['d', 4], ['e', 4]],
    );
    assert.deepEqual(winnersOf(ranked), ['b', 'c']);
    assert.deepEqual(winnersOf(rankByScore([{ playerId: 'a', score: 0 }, { playerId: 'b', score: 0 }])), []);
    assert.deepEqual(winnersOf(rankByScore([{ playerId: 'a', score: 5 }, { playerId: 'b', score: 0 }])), ['a']);
  });
});

describe('scoring in play', () => {
  it('awards the speed bonus by time left and drawer points per correct guesser', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob', 'Cara', 'Dan');
    m.startGame(room.code, ids.Alice!);
    const word = choose(m, room);
    advance(15_000); // 45s left
    assert.deepEqual(m.sendChat(room.code, ids.Bob!, word), { status: 'correct' });
    advance(30_000); // 15s left
    m.sendChat(room.code, ids.Cara!, word);
    assert.equal(scoreOf(m, room, ids.Bob!), guessPoints(1, 45_000, DRAW_MS)); // 50 + 38 = 88
    assert.equal(scoreOf(m, room, ids.Bob!), 88);
    assert.equal(scoreOf(m, room, ids.Cara!), guessPoints(2, 15_000, DRAW_MS)); // 40 + 13 = 53
    assert.equal(scoreOf(m, room, ids.Alice!), 2 * SCORING.drawerPerGuess);
    assert.equal(scoreOf(m, room, ids.Dan!), 0, 'players who have not guessed have zero');
    assert.deepEqual(m.toSnapshot(room).round!.points, { [ids.Bob!]: 88, [ids.Alice!]: 50, [ids.Cara!]: 53 });
  });

  it('gives nothing for wrong guesses, chat, repeats, or guesses outside the drawing phase', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    const choices = [...room.round!.choices];
    m.sendChat(room.code, ids.Bob!, choices[0]!); // still choosing: plain chat, no points
    assert.equal(scoreOf(m, room, ids.Bob!), 0);
    const word = choose(m, room);
    m.sendChat(room.code, ids.Bob!, 'is it a cat');
    m.sendChat(room.code, ids.Bob!, `${word}s`);
    assert.equal(scoreOf(m, room, ids.Bob!), 0);
    assertRoomError(() => m.sendChat(room.code, ids.Alice!, word), 'DRAWER_CANNOT_CHAT');
    m.sendChat(room.code, ids.Bob!, word);
    const once = scoreOf(m, room, ids.Bob!);
    for (let i = 0; i < 5; i++) m.sendChat(room.code, ids.Bob!, word.toUpperCase());
    assert.equal(scoreOf(m, room, ids.Bob!), once, 'repeating the answer never scores again');
    assert.equal(scoreOf(m, room, ids.Alice!), SCORING.drawerPerGuess);
  });

  it('orders simultaneous correct guesses and scores each exactly once', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob', 'Cara', 'Dan');
    m.startGame(room.code, ids.Alice!);
    const word = choose(m, room);
    // Same instant: arrival order decides who was first.
    m.sendChat(room.code, ids.Cara!, word);
    m.sendChat(room.code, ids.Bob!, word);
    m.sendChat(room.code, ids.Cara!, word);
    assert.equal(scoreOf(m, room, ids.Cara!), 100);
    assert.equal(scoreOf(m, room, ids.Bob!), 90);
    assert.deepEqual(room.round!.guessed, [ids.Cara!, ids.Bob!]);
  });

  it('a guess that arrives after time is up (before the timer fires) does not score', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob');
    m.startGame(room.code, ids.Alice!);
    const word = choose(m, room);
    mock.timers.setTime(Date.now() + DRAW_MS); // deadline reached, timer callback not yet run
    assert.deepEqual(m.sendChat(room.code, ids.Bob!, word), { status: 'sent' });
    assert.equal(room.phase, 'round-end');
    assert.equal(room.round!.endReason, 'timeout');
    assert.equal(scoreOf(m, room, ids.Bob!), 0);
    advance(0); // the (already cleared) timer must not end the round twice
    assert.equal(room.match!.results.length, 1);
  });

  it('a timeout racing the last correct guess ends the round exactly once', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob');
    m.startGame(room.code, ids.Alice!);
    const word = choose(m, room);
    mock.timers.setTime(Date.now() + DRAW_MS - 1);
    m.sendChat(room.code, ids.Bob!, word); // just in time
    assert.equal(room.round!.endReason, 'all-guessed');
    advance(5);
    assert.equal(room.match!.results.length, 1);
    assert.equal(room.round!.endReason, 'all-guessed');
    assert.equal(scoreOf(m, room, ids.Bob!), 50);
  });
});

describe('drawer rotation rule', () => {
  const c = (id: string, joinSeq: number, draws: number) => ({ id, joinSeq, draws });

  it('prefers fewest draws, then the next player in join order (wrapping)', () => {
    assert.equal(pickDrawer([c('a', 1, 1), c('b', 2, 0), c('c', 3, 0)], 'a', 1).id, 'b');
    assert.equal(pickDrawer([c('a', 1, 1), c('b', 2, 1), c('c', 3, 0)], 'b', 2).id, 'c');
    assert.equal(pickDrawer([c('a', 1, 1), c('b', 2, 1), c('c', 3, 1)], 'c', 3).id, 'a', 'wraps around');
  });

  it('never repeats the previous drawer when someone else is eligible, even if they have fewer draws', () => {
    // 'a' just drew but still has the fewest draws (they missed turns while offline).
    assert.equal(pickDrawer([c('a', 1, 1), c('b', 2, 3), c('c', 3, 2)], 'a', 1).id, 'c');
    assert.equal(pickDrawer([c('a', 1, 0)], 'a', 1).id, 'a', 'unless they are the only candidate');
  });
});

describe('five-round match', () => {
  it('plays exactly five rounds with fair rotation, then shows ranked final standings', () => {
    const m = setup();
    const { room, ids, nameOf } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    const drawers: string[] = [];
    const expected: Record<string, number> = { Alice: 0, Bob: 0, Cara: 0 };

    for (let n = 1; n <= MATCH_ROUNDS; n++) {
      assert.equal(room.phase, 'choosing');
      assert.equal(room.match!.roundNumber, n);
      assert.equal(m.toSnapshot(room).round!.number, n);
      const drawer = nameOf(room.round!.drawerId);
      drawers.push(drawer);
      const word = choose(m, room);
      // Only the first guesser in join order guesses, instantly → 100 + 25 for the drawer.
      const guesser = Object.keys(ids).find((name) => name !== drawer)!;
      m.sendChat(room.code, ids[guesser]!, word);
      expected[guesser]! += 100;
      expected[drawer]! += SCORING.drawerPerGuess;
      advance(DRAW_MS); // the other guesser never gets it → timeout
      assert.equal(room.phase, 'round-end');
      const result = m.toSnapshot(room).match!.lastResult!;
      assert.equal(result.roundNumber, n);
      assert.equal(result.word, word);
      assert.equal(result.drawerNickname, drawer);
      assert.deepEqual(
        Object.fromEntries(result.entries.map((e) => [e.nickname, [e.points, e.total, e.guessed, e.isDrawer]])),
        Object.fromEntries(
          Object.keys(ids).map((name) => [
            name,
            [name === guesser ? 100 : name === drawer ? 25 : 0, expected[name], name === guesser, name === drawer],
          ]),
        ),
      );
      advance(RESULTS_MS); // results timer advances the match
    }

    assert.deepEqual(drawers, ['Alice', 'Bob', 'Cara', 'Alice', 'Bob']);
    for (let i = 1; i < drawers.length; i++) assert.notEqual(drawers[i], drawers[i - 1], 'no back-to-back drawer');
    assert.equal(room.phase, 'match-end');
    const snap = m.toSnapshot(room);
    assert.equal(snap.round, null);
    assert.equal(snap.match!.endReason, 'completed');
    assert.deepEqual(
      snap.match!.standings.map((s) => [s.nickname, s.score, s.rank]),
      Object.entries(expected)
        .sort((a, b) => b[1] - a[1])
        .map(([name, score], i, all) => [name, score, all.findIndex(([, s]) => s === score) + 1]),
    );
    assert.equal(snap.match!.standings.reduce((sum, s) => sum + s.roundsDrawn, 0), MATCH_ROUNDS);
    assert.deepEqual(snap.match!.winnerIds, [snap.match!.standings[0]!.playerId]);
    assertRoomError(() => m.nextRound(room.code, ids.Alice!), 'INVALID_PHASE');
    assertRoomError(() => m.chooseWord(room.code, ids.Alice!, 0), 'INVALID_PHASE');
  });

  it('gives everyone a turn before anyone draws twice, and never the same drawer twice in a row', () => {
    const m = setup();
    const six = roomWith(m, 'A', 'B', 'C', 'D', 'E', 'F');
    const played = playMatchQuickly(m, six.room, six.ids.A!).map(six.nameOf);
    assert.deepEqual(played, ['A', 'B', 'C', 'D', 'E']);

    const m2 = setup();
    const two = roomWith(m2, 'A', 'B');
    assert.deepEqual(playMatchQuickly(m2, two.room, two.ids.A!).map(two.nameOf), ['A', 'B', 'A', 'B', 'A']);
  });

  it('skips disconnected players in rotation and continues fairly', () => {
    const m = setup();
    const { room, ids, nameOf } = roomWith(m, 'A', 'B', 'C');
    m.startGame(room.code, ids.A!);
    m.markDisconnected(room.code, ids.B!, 's-B');
    endRoundByTimeout(m, room);
    m.nextRound(room.code, ids.A!);
    assert.equal(nameOf(room.round!.drawerId), 'C', 'B is offline, A just drew');
  });

  it('ignores repeated Next Round / Play Again requests and never advances twice', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob');
    m.startGame(room.code, ids.Alice!);
    endRoundByTimeout(m, room);
    m.nextRound(room.code, ids.Alice!);
    assertRoomError(() => m.nextRound(room.code, ids.Alice!), 'INVALID_PHASE');
    assert.equal(room.match!.roundNumber, 2);
    // The results timer of round 1 was cancelled by the host's advance.
    advance(RESULTS_MS * 2);
    assert.equal(room.match!.roundNumber, 2);
    assert.equal(room.phase, 'drawing', 'auto-picked word after the choice timer');

    assertRoomError(() => m.nextRound(room.code, ids.Bob!), 'NOT_HOST');
    assertRoomError(() => m.playAgain(room.code, ids.Alice!), 'INVALID_PHASE');
    assertRoomError(() => m.startGame(room.code, ids.Alice!), 'GAME_IN_PROGRESS');

    finishMatch(m, room, ids.Alice!);
    assertRoomError(() => m.playAgain(room.code, ids.Bob!), 'NOT_HOST');
    m.playAgain(room.code, ids.Alice!);
    const matchId = room.match!.id;
    assertRoomError(() => m.playAgain(room.code, ids.Alice!), 'INVALID_PHASE');
    assert.equal(room.match!.id, matchId);
    assert.equal(room.match!.roundNumber, 1);
  });

  it('Play Again resets scores, rounds, results, guesses and drawing exactly once', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    const word = choose(m, room);
    m.sendChat(room.code, ids.Bob!, word);
    m.applyDrawOps(room.code, ids.Alice!, 's-Alice', {
      roundId: room.round!.id,
      ops: [{ t: 'begin', id: 1, tool: 'pen', color: '#1f2333', size: 8, x: 1, y: 1 }],
    });
    finishMatch(m, room, ids.Alice!);
    const lastDrawer = room.lastDrawerId;
    const oldMatchId = room.match!.id;
    assert.ok(m.toSnapshot(room).match!.standings.some((s) => s.score > 0));

    m.playAgain(room.code, ids.Alice!);
    const snap = m.toSnapshot(room);
    assert.equal(room.phase, 'choosing');
    assert.equal(snap.match!.id, oldMatchId + 1);
    assert.equal(snap.match!.roundNumber, 1);
    assert.equal(snap.match!.lastResult, null);
    assert.equal(snap.match!.endReason, null);
    assert.equal(room.match!.results.length, 0);
    assert.ok(snap.match!.standings.every((s) => s.score === 0 && s.roundsGuessed === 0));
    assert.deepEqual(snap.round!.guessedIds, []);
    assert.deepEqual(snap.round!.points, {});
    assert.equal(room.round!.drawing.strokes.length, 0);
    assert.notEqual(room.round!.drawerId, lastDrawer, 'rematch does not start with the previous drawer');
  });

  it('Return to Lobby clears match state but keeps everyone seated', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob');
    m.startGame(room.code, ids.Alice!);
    choose(m, room);
    m.returnToLobby(room.code, ids.Alice!);
    assert.equal(room.phase, 'lobby');
    assert.equal(room.match, null);
    assert.equal(m.toSnapshot(room).match, null);
    assert.equal(room.players.size, 2);
    advance(DRAW_MS + RESULTS_MS * 2);
    assert.equal(room.phase, 'lobby', 'no stale timer moves the room');
    assert.deepEqual(changed, []);
    m.startGame(room.code, ids.Alice!);
    assert.equal(room.match!.roundNumber, 1);
  });
});

describe('players changing during a match', () => {
  it('a guesser leaving drops them from the standings; the match continues', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    const word = choose(m, room);
    m.sendChat(room.code, ids.Cara!, word);
    m.removePlayer(room.code, ids.Cara!);
    assert.equal(room.phase, 'drawing', 'Bob is still guessing');
    const standings = m.toSnapshot(room).match!.standings;
    assert.deepEqual(standings.map((s) => s.playerId).sort(), [ids.Alice!, ids.Bob!].sort());
    assert.equal(scoreOf(m, room, ids.Alice!), SCORING.drawerPerGuess, 'drawer keeps points earned from Cara');
  });

  it('the drawer leaving during word choice ends that round (it still counts) and the match goes on', () => {
    const m = setup();
    const { room, ids, nameOf } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    m.removePlayer(room.code, ids.Alice!);
    assert.equal(room.phase, 'round-end');
    const result = m.toSnapshot(room).match!.lastResult!;
    assert.equal(result.endReason, 'drawer-left');
    assert.equal(result.word, null);
    assert.equal(result.drawerNickname, 'Alice');
    advance(RESULTS_MS);
    assert.equal(room.phase, 'choosing');
    assert.equal(room.match!.roundNumber, 2);
    assert.equal(nameOf(room.round!.drawerId), 'Bob');
    assert.equal(room.hostId, ids.Bob, 'host moved to Bob');
  });

  it('ends the match (with standings) when fewer than two players remain', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob');
    m.startGame(room.code, ids.Alice!);
    const word = choose(m, room);
    m.sendChat(room.code, ids.Bob!, word); // round ends: all guessed
    advance(RESULTS_MS);
    m.removePlayer(room.code, ids.Alice!); // drawer of round 2 leaves
    assert.equal(room.phase, 'round-end');
    advance(RESULTS_MS);
    assert.equal(room.phase, 'match-end');
    const snap = m.toSnapshot(room);
    assert.equal(snap.match!.endReason, 'not-enough-players');
    assert.deepEqual(snap.match!.standings.map((s) => [s.nickname, s.score]), [['Bob', 100]]);
    assert.deepEqual(snap.match!.winnerIds, [ids.Bob]);
    assertRoomError(() => m.playAgain(room.code, ids.Bob!), 'NOT_ENOUGH_PLAYERS');
  });

  it('pauses between rounds while fewer than two are connected, and resumes on reconnect', () => {
    const m = setup();
    const { room, ids, tokens } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    endRoundByTimeout(m, room);
    m.markDisconnected(room.code, ids.Bob!, 's-Bob');
    m.markDisconnected(room.code, ids.Cara!, 's-Cara');
    advance(RESULTS_MS);
    assert.equal(room.phase, 'round-end');
    assert.equal(m.toSnapshot(room).match!.waitingForPlayers, true);
    assertRoomError(() => m.nextRound(room.code, ids.Alice!), 'NOT_ENOUGH_PLAYERS');
    m.rejoinRoom(room.code, tokens.Bob!, 's-Bob2');
    assert.equal(m.toSnapshot(room).match!.waitingForPlayers, false);
    advance(3000);
    assert.equal(room.phase, 'choosing');
    assert.equal(room.match!.roundNumber, 2);
  });

  it('a paused match ends when the missing seats expire', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob');
    m.startGame(room.code, ids.Alice!);
    endRoundByTimeout(m, room);
    m.markDisconnected(room.code, ids.Bob!, 's-Bob');
    advance(RESULTS_MS);
    assert.equal(m.toSnapshot(room).match!.waitingForPlayers, true);
    advance(30_000); // Bob's seat expires
    assert.equal(room.phase, 'match-end');
    assert.equal(room.match!.endReason, 'not-enough-players');
  });

  it('host changes mid-match: the new host controls the match, the old one cannot', () => {
    const m = setup();
    const { room, ids, tokens } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    m.markDisconnected(room.code, ids.Alice!, 's-Alice');
    advance(10_000); // host hand-off
    assert.equal(room.hostId, ids.Bob);
    advance(CHOICE_MS - 10_000);
    assert.equal(room.phase, 'drawing', 'auto-picked word for the absent drawer; the round keeps going');
    m.rejoinRoom(room.code, tokens.Alice!, 's-Alice2'); // back within the grace period, as a regular player
    assert.equal(room.hostId, ids.Bob);
    advance(DRAW_MS); // round ends
    assertRoomError(() => m.nextRound(room.code, ids.Alice!), 'NOT_HOST');
    m.nextRound(room.code, ids.Bob!);
    assert.equal(room.match!.roundNumber, 2);
  });

  it('reconnecting keeps scores and guessed status; no double award', () => {
    const m = setup();
    const { room, ids, tokens } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    const word = choose(m, room);
    m.sendChat(room.code, ids.Bob!, word);
    const before = scoreOf(m, room, ids.Bob!);
    m.markDisconnected(room.code, ids.Bob!, 's-Bob');
    m.rejoinRoom(room.code, tokens.Bob!, 's-Bob2');
    assert.deepEqual(m.sendChat(room.code, ids.Bob!, word), { status: 'sent' });
    assert.equal(scoreOf(m, room, ids.Bob!), before);
    assert.equal(m.privateRoundFor(room, ids.Bob!)?.word, word);
  });

  it('abandoned rooms are deleted with all their timers', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob');
    m.startGame(room.code, ids.Alice!);
    endRoundByTimeout(m, room);
    changed = [];
    m.markDisconnected(room.code, ids.Alice!, 's-Alice');
    m.markDisconnected(room.code, ids.Bob!, 's-Bob');
    advance(30_000);
    assert.equal(m.getRoom(room.code), undefined);
    changed = [];
    advance(10 * 60_000);
    assert.deepEqual(changed, [], 'no timer fires for a deleted room');
    assert.equal(m.roomCount, 0);
  });
});

describe('final standings', () => {
  it('handles ties and zero-score players', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob', 'Cara');
    finishMatch(m, room, ids.Alice!, () => {}); // nobody guesses anything
    const snap = m.toSnapshot(room).match!;
    assert.ok(snap.standings.every((s) => s.score === 0 && s.rank === 1));
    assert.deepEqual(snap.winnerIds, [], 'no winner when nobody scored');
    assert.deepEqual(snap.standings.map((s) => s.nickname), ['Alice', 'Bob', 'Cara'], 'ties keep join order');
  });

  it('declares a shared win on equal top scores', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob');
    // Rounds alternate A, B, A, B, A. Each guesser answers instantly: guesser +100, drawer +25.
    // Alice: 2×100 (as guesser) + 3×25 = 275; Bob: 3×100 + 2×25 = 350. Make it a tie by having Bob skip one round.
    let round = 0;
    finishMatch(m, room, ids.Alice!, (word, drawerId) => {
      round++;
      const guesser = drawerId === ids.Alice ? ids.Bob! : ids.Alice!;
      if (guesser === ids.Bob && round === 5) return; // Bob skips round 5: Bob 200+50=250, Alice 200+50=250
      m.sendChat(room.code, guesser, word);
    });
    const snap = m.toSnapshot(room).match!;
    assert.deepEqual(snap.standings.map((s) => [s.nickname, s.score, s.rank]), [
      ['Alice', 250, 1],
      ['Bob', 250, 1],
    ]);
    assert.deepEqual(snap.winnerIds.sort(), [ids.Alice!, ids.Bob!].sort());
    assert.deepEqual(snap.standings.map((s) => s.roundsGuessed), [2, 2]);
  });
});

describe('secret word privacy across the match', () => {
  it('never uses a word that an earlier drawer was offered (chosen or not)', () => {
    const words = Array.from({ length: 30 }, (_, i) => `wordno${i}x`);
    for (let trial = 0; trial < 20; trial++) {
      const m = setup({ words });
      const { room, ids } = roomWith(m, 'Alice', 'Bob', 'Cara');
      m.startGame(room.code, ids.Alice!);
      const offered = new Set<string>();
      while (room.phase !== 'match-end') {
        if (room.phase === 'choosing') {
          for (const w of room.round!.choices) {
            assert.ok(!offered.has(w), `"${w}" was offered in an earlier round`);
            offered.add(w);
          }
          choose(m, room);
        }
        if (room.phase === 'drawing') advance(DRAW_MS);
        if (room.phase === 'round-end') m.nextRound(room.code, room.hostId);
      }
      assert.equal(offered.size, MATCH_ROUNDS * 3);
    }
  });

  it('no round word appears in public state before that round is over', () => {
    const m = setup();
    const { room, ids } = roomWith(m, 'Alice', 'Bob', 'Cara');
    m.startGame(room.code, ids.Alice!);
    for (let n = 1; n <= MATCH_ROUNDS; n++) {
      const secret = [...room.round!.choices];
      const guesser = [...room.players.keys()].find((id) => id !== room.round!.drawerId)!;
      const assertHidden = (label: string) => {
        const json = JSON.stringify(m.toSnapshot(room)) + JSON.stringify(m.gameRestoreFor(room, guesser));
        for (const w of secret) assert.ok(!json.includes(w), `round ${n} (${label}) leaked "${w}"`);
      };
      assertHidden('choosing');
      const word = choose(m, room);
      assertHidden('drawing');
      m.sendChat(room.code, guesser, `maybe ${word}?`);
      assertHidden('after a near-miss guess');
      advance(DRAW_MS);
      assert.equal(m.toSnapshot(room).match!.lastResult!.word, word, 'revealed at round end');
      advance(RESULTS_MS);
    }
    assert.equal(room.phase, 'match-end');
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function endRoundByTimeout(m: RoomManager, room: Room) {
  if (room.phase === 'choosing') choose(m, room);
  advance(DRAW_MS);
  assert.equal(room.phase, 'round-end');
}

/** Plays a whole match with the host skipping results; returns the drawer of each round. */
function playMatchQuickly(m: RoomManager, room: Room, hostId: string): string[] {
  const drawers: string[] = [];
  m.startGame(room.code, hostId);
  for (let n = 1; n <= MATCH_ROUNDS; n++) {
    drawers.push(room.round!.drawerId);
    endRoundByTimeout(m, room);
    m.nextRound(room.code, room.hostId);
  }
  assert.equal(room.phase, 'match-end');
  return drawers;
}

/** Plays to match-end. `onDrawing(word, drawerId)` runs once per round after the word is chosen. */
function finishMatch(m: RoomManager, room: Room, hostId: string, onDrawing?: (word: string, drawerId: string) => void) {
  if (room.phase === 'lobby') m.startGame(room.code, hostId);
  while (room.phase !== 'match-end') {
    if (room.phase === 'choosing') {
      const word = choose(m, room);
      onDrawing?.(word, room.round!.drawerId);
    }
    if (room.phase === 'drawing') advance(DRAW_MS);
    if (room.phase === 'round-end') m.nextRound(room.code, room.hostId);
  }
}
