import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  CHAT_MAX_LENGTH,
  MATCH_ROUNDS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  WORD_CHOICES,
  nicknameKey,
  type ChatMessage,
  type ChatResult,
  type DrawOp,
  type DrawOpsPayload,
  type GameRestore,
  type MatchEndReason,
  type MatchSnapshot,
  type PrivateRoundInfo,
  type RoundResult,
  type RoomPhase,
  type RoomSnapshot,
  type RoundEndReason,
} from '@draw-guess/shared';
import { applyDrawOps, cloneStrokes, emptyStrokeStore, type StrokeStore } from '../game/drawing.js';
import { cleanChatText, isCorrectGuess, maskWord, mentionsWord } from '../game/guess.js';
import { pickDrawer } from '../game/rotation.js';
import { DRAWER_POINTS_PER_GUESS, guessPoints, rankByScore, winnersOf } from '../game/scoring.js';
import { WORDS, pickWords } from '../game/words.js';
import { RoomError } from './RoomError.js';
import { generateRoomCode } from './roomCode.js';

/** Chat messages kept per room for players who rejoin mid-round. */
const CHAT_HISTORY_LIMIT = 50;
/** After a paused match gets enough players back, wait this long before continuing. */
const RESUME_DELAY_MS = 3000;

export interface Player {
  id: string;
  nickname: string;
  color: string;
  joinedAt: number;
  /** Secret that lets this player reclaim their seat. Never broadcast. */
  sessionToken: string;
  /** Socket currently attached to this seat, or null while disconnected. */
  socketId: string | null;
  removalTimer: NodeJS.Timeout | null;
  /** Monotonic join order (ties in joinedAt are possible), used for drawer rotation. */
  joinSeq: number;
}

/** Server-only round state. `choices` and `word` must never reach non-entitled players. */
export interface Round {
  id: number;
  /** 1-based round number within the match. */
  number: number;
  drawerId: string;
  /** Kept so results can name a drawer who has since left. */
  drawerNickname: string;
  choices: string[];
  word: string | null;
  phaseEndsAt: number | null;
  phaseDurationMs: number | null;
  timer: NodeJS.Timeout | null;
  /** Player ids in the order they guessed correctly. */
  guessed: string[];
  drawing: StrokeStore;
  endReason: RoundEndReason | null;
  /** Points earned this round, by player id. */
  points: Map<string, number>;
}

export interface PlayerScore {
  score: number;
  roundsGuessed: number;
  roundsDrawn: number;
}

/** A five-round match. Scores are keyed by player id, so reconnecting never resets or duplicates them. */
export interface Match {
  id: number;
  /** Rounds started so far (the current round's number while one is running). */
  roundNumber: number;
  scores: Map<string, PlayerScore>;
  lastDrawerId: string | null;
  results: RoundResult[];
  /** Auto-advance out of round-end. */
  advanceTimer: NodeJS.Timeout | null;
  advanceAt: number | null;
  /** Round-end is paused until at least two players are connected again. */
  waitingForPlayers: boolean;
  endReason: MatchEndReason | null;
}

export interface Room {
  code: string;
  phase: RoomPhase;
  hostId: string;
  /** Insertion order == join order, which drives host hand-off. */
  players: Map<string, Player>;
  createdAt: number;
  /** Pending transfer of host away from a disconnected host. */
  hostHandoffTimer: NodeJS.Timeout | null;
  round: Round | null;
  roundCounter: number;
  match: Match | null;
  matchCounter: number;
  /** joinSeq of the most recent drawer; rotation continues after it (also across matches). */
  lastDrawerSeq: number;
  /** Most recent drawer, so a rematch doesn't start with the same person. */
  lastDrawerId: string | null;
  usedWords: Set<string>;
  chat: ChatMessage[];
  chatCounter: number;
}

export interface RoomManagerOptions {
  maxPlayersPerRoom: number;
  maxRooms: number;
  reconnectGraceMs: number;
  /** How long a disconnected host keeps the host role before it moves to a connected player. */
  hostHandoffMs: number;
  /** How long the drawer has to pick a word before one is picked for them. */
  wordChoiceMs: number;
  /** Length of the drawing phase. */
  drawTimeMs: number;
  /** How long round results are shown before the match moves on by itself. */
  roundResultsMs: number;
  /** Word list override (tests). */
  words?: readonly string[];
  /** Called when a room changes outside a request (e.g. grace-period expiry, round timers). */
  onRoomChanged?: (code: string) => void;
  /** A player's private round info changed; send them `privateRoundFor()`. */
  onPrivateRound?: (code: string, playerId: string) => void;
  /** A chat message to deliver: to everyone (`audience` null) or only the listed player ids. */
  onChat?: (code: string, message: ChatMessage, audience: string[] | null) => void;
}

export interface Seat {
  room: Room;
  player: Player;
}

/**
 * Authoritative in-memory room state. Knows nothing about sockets so it can be
 * unit-tested directly; the socket layer translates events into these calls.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private joinSeq = 0;

  constructor(private readonly options: RoomManagerOptions) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) count += room.players.size;
    return count;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  createRoom(nickname: string, socketId: string): Seat {
    if (this.rooms.size >= this.options.maxRooms) throw new RoomError('SERVER_FULL');

    const code = generateRoomCode((c) => this.rooms.has(c));
    const player = this.newPlayer(nickname, socketId, PLAYER_COLORS[0]);
    const room: Room = {
      code,
      phase: 'lobby',
      hostId: player.id,
      players: new Map([[player.id, player]]),
      createdAt: Date.now(),
      hostHandoffTimer: null,
      round: null,
      roundCounter: 0,
      match: null,
      matchCounter: 0,
      lastDrawerSeq: 0,
      lastDrawerId: null,
      usedWords: new Set(),
      chat: [],
      chatCounter: 0,
    };
    this.rooms.set(code, room);
    return { room, player };
  }

  joinRoom(code: string, nickname: string, socketId: string): Seat {
    const room = this.requireRoom(code);
    if (room.phase !== 'lobby') throw new RoomError('GAME_IN_PROGRESS');
    if (room.players.size >= this.options.maxPlayersPerRoom) throw new RoomError('ROOM_FULL');

    const key = nicknameKey(nickname);
    for (const other of room.players.values()) {
      if (nicknameKey(other.nickname) === key) throw new RoomError('NICKNAME_TAKEN');
    }

    const player = this.newPlayer(nickname, socketId, this.nextColor(room));
    room.players.set(player.id, player);
    return { room, player };
  }

  /** Looks up a seat by its session token without changing anything. */
  findSeat(code: string, sessionToken: string): Seat {
    const room = this.rooms.get(code);
    const player = room && [...room.players.values()].find((p) => p.sessionToken === sessionToken);
    if (!room || !player) throw new RoomError('SESSION_EXPIRED');
    return { room, player };
  }

  /**
   * Re-attaches a socket to an existing seat. Returns the socket id previously
   * attached (if any) so the caller can tell that connection it was replaced.
   */
  rejoinRoom(code: string, sessionToken: string, socketId: string): Seat & { previousSocketId: string | null } {
    const { room, player } = this.findSeat(code, sessionToken);
    this.clearRemovalTimer(player);
    if (room.hostId === player.id) this.clearHostHandoff(room);
    const previousSocketId = player.socketId !== socketId ? player.socketId : null;
    player.socketId = socketId;
    const match = room.match;
    if (room.phase === 'round-end' && match?.waitingForPlayers && this.connectedCount(room) >= MIN_PLAYERS) {
      match.waitingForPlayers = false;
      this.scheduleAdvance(room, Math.min(RESUME_DELAY_MS, this.options.roundResultsMs));
    }
    return { room, player, previousSocketId };
  }

  /** Marks the player as disconnected and starts their grace period. */
  markDisconnected(code: string, playerId: string, socketId: string): void {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    // Ignore stale disconnects from a socket that has already been replaced.
    if (!room || !player || player.socketId !== socketId) return;

    player.socketId = null;
    this.clearRemovalTimer(player);
    player.removalTimer = this.safeTimeout(() => {
      player.removalTimer = null;
      if (player.socketId !== null) return;
      this.removePlayer(code, playerId);
      this.options.onRoomChanged?.(code);
    }, this.options.reconnectGraceMs);

    if (room.hostId === playerId) this.scheduleHostHandoff(room);
    // A disconnected guesser no longer holds up an "everyone guessed" finish.
    this.checkAllGuessed(room);
  }

  /** Removes a player immediately, handing off host and deleting empty rooms. */
  removePlayer(code: string, playerId: string): void {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player) return;

    this.clearRemovalTimer(player);
    room.players.delete(playerId);

    if (room.players.size === 0) {
      this.clearHostHandoff(room);
      this.clearRoundTimer(room);
      this.clearAdvanceTimer(room);
      this.rooms.delete(code);
      return;
    }
    if (room.hostId === playerId) {
      this.clearHostHandoff(room);
      // Prefer the longest-standing connected player; fall back to anyone.
      const players = [...room.players.values()];
      const next = players.find((p) => p.socketId !== null) ?? players[0]!;
      room.hostId = next.id;
      if (next.socketId === null) this.scheduleHostHandoff(room);
    }
    if (room.round && (room.phase === 'choosing' || room.phase === 'drawing')) {
      if (room.round.drawerId === playerId) this.endRound(room, 'drawer-left');
      else if (room.players.size < MIN_PLAYERS) this.endRound(room, 'not-enough-players');
      else this.checkAllGuessed(room);
    }
    // A paused match that can no longer reach two players ends now.
    if (room.phase === 'round-end' && room.match?.waitingForPlayers && room.players.size < MIN_PLAYERS) {
      this.finishMatch(room, 'not-enough-players');
    }
  }

  // ── Match + round state machine ────────────────────────────────────────────
  // lobby ──start──▶ choosing ──chooseWord / timeout──▶ drawing ──timeout / all guessed──▶ round-end
  // round-end ──results timer / host "next"──▶ choosing (rounds 1–4) | match-end (after round 5)
  // match-end ──play again──▶ choosing (fresh match);  any game phase ──returnToLobby──▶ lobby
  // choosing/drawing ──drawer leaves / too few players──▶ round-end
  // round-end with < 2 connected ──▶ paused (resumes on reconnect; ends the match if seats drop below 2)
  // Every transition checks the current phase first, so repeated requests or racing timers are no-ops.

  /** lobby → choosing (round 1 of a new match). */
  startGame(code: string, playerId: string): Room {
    const room = this.requireMembership(code, playerId);
    if (room.hostId !== playerId) throw new RoomError('NOT_HOST');
    if (room.phase !== 'lobby') throw new RoomError('GAME_IN_PROGRESS');
    this.startMatch(room);
    return room;
  }

  /** Host skips the results countdown. round-end → next round, or match-end after the last round. */
  nextRound(code: string, playerId: string): Room {
    const room = this.requireMembership(code, playerId);
    if (room.hostId !== playerId) throw new RoomError('NOT_HOST');
    if (room.phase !== 'round-end') throw new RoomError('INVALID_PHASE');
    this.advance(room, 'host');
    return room;
  }

  /** match-end → choosing (round 1 of a fresh match). */
  playAgain(code: string, playerId: string): Room {
    const room = this.requireMembership(code, playerId);
    if (room.hostId !== playerId) throw new RoomError('NOT_HOST');
    if (room.phase !== 'match-end') throw new RoomError('INVALID_PHASE');
    this.startMatch(room);
    return room;
  }

  /** Any phase → lobby. Cancels the round and match in progress; everyone keeps their seat. */
  returnToLobby(code: string, playerId: string): Room {
    const room = this.requireMembership(code, playerId);
    if (room.hostId !== playerId) throw new RoomError('NOT_HOST');
    this.clearRoundTimer(room);
    this.clearAdvanceTimer(room);
    room.round = null;
    room.match = null;
    room.chat = [];
    room.phase = 'lobby';
    return room;
  }

  /** choosing → drawing. Only the drawer, only with a valid choice index. */
  chooseWord(code: string, playerId: string, index: unknown): Room {
    const room = this.requireMembership(code, playerId);
    const round = room.round;
    if (room.phase !== 'choosing' || !round) throw new RoomError('INVALID_PHASE');
    if (round.drawerId !== playerId) throw new RoomError('NOT_DRAWER');
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= round.choices.length) {
      throw new RoomError('INVALID_PAYLOAD');
    }
    this.beginDrawing(room, round.choices[index as number]!);
    return room;
  }

  /**
   * Handles a chat line. While drawing, a guesser's message is checked against
   * the word: a match is never shown as chat, only as a "guessed it" event.
   */
  sendChat(code: string, playerId: string, rawText: unknown): ChatResult {
    const room = this.requireMembership(code, playerId);
    const player = room.players.get(playerId)!;
    // The lobby has no chat UI; accepting messages there would only queue up unseen spam.
    if (room.phase === 'lobby') throw new RoomError('INVALID_PHASE');
    if (typeof rawText !== 'string' || rawText.length > CHAT_MAX_LENGTH * 4) throw new RoomError('INVALID_MESSAGE');
    const text = cleanChatText(rawText);
    if (text.length === 0 || [...text].length > CHAT_MAX_LENGTH) throw new RoomError('INVALID_MESSAGE');

    const round = room.round;
    const roundActive = round !== null && (room.phase === 'choosing' || room.phase === 'drawing');
    if (roundActive && round.drawerId === playerId) throw new RoomError('DRAWER_CANNOT_CHAT');

    // A message that arrives after the drawing time is up (before the timer callback
    // has run) must not score: end the round first, then treat it as round-end chat.
    if (roundActive && room.phase === 'drawing' && round.phaseEndsAt !== null && Date.now() >= round.phaseEndsAt) {
      this.endRound(room, 'timeout');
      this.options.onRoomChanged?.(room.code);
      this.postChat(room, { kind: 'chat', playerId, nickname: player.nickname, text });
      return { status: 'sent' };
    }

    const hasGuessed = roundActive && round.guessed.includes(playerId);
    if (roundActive && room.phase === 'drawing' && round.word && isCorrectGuess(text, round.word)) {
      // Repeating the answer after guessing it never counts twice or leaks the word.
      if (hasGuessed) return { status: 'sent' };
      round.guessed.push(playerId);
      const points = this.awardGuess(room, round, playerId);
      this.postChat(room, {
        kind: 'correct',
        playerId,
        nickname: player.nickname,
        text: `${player.nickname} guessed the word!`,
        points,
      });
      this.options.onPrivateRound?.(room.code, playerId);
      this.checkAllGuessed(room);
      return { status: 'correct' };
    }

    // A message that contains the answer without being an exact guess would reveal it
    // to everyone. Only the drawer and players who already know the word see it; the
    // sender sees their own message as usual (so they get no "you were close" hint).
    if (roundActive && room.phase === 'drawing' && round.word && !hasGuessed && mentionsWord(text, round.word)) {
      const withheld = this.postChat(room, { kind: 'chat', playerId, nickname: player.nickname, text, withheld: true }, 'guessed');
      const { withheld: _flag, ...forSender } = withheld;
      this.options.onChat?.(room.code, { ...forSender, scope: 'all' }, [playerId]);
      return { status: 'sent' };
    }

    // Players who know the word can only talk among themselves until the round ends.
    const scope = hasGuessed ? 'guessed' : 'all';
    this.postChat(room, { kind: 'chat', playerId, nickname: player.nickname, text }, scope);
    return { status: 'sent' };
  }

  /** Validates drawer + round, stores the ops, and returns the accepted ops to relay. */
  applyDrawOps(code: string, playerId: string, socketId: string, payload: DrawOpsPayload): DrawOp[] {
    const room = this.requireDrawer(code, playerId, socketId, payload.roundId);
    return applyDrawOps(room.round!.drawing, payload.ops);
  }

  clearCanvas(code: string, playerId: string, socketId: string, roundId: unknown): Room {
    const room = this.requireDrawer(code, playerId, socketId, roundId);
    room.round!.drawing = { ...emptyStrokeStore(), lastStrokeId: room.round!.drawing.lastStrokeId };
    return room;
  }

  /** The drawer's choices/word, or the word for players who already guessed it. */
  privateRoundFor(room: Room, playerId: string): PrivateRoundInfo | null {
    const round = room.round;
    if (!round || room.phase === 'lobby' || room.phase === 'match-end') return null;
    if (round.drawerId === playerId) {
      return {
        roundId: round.id,
        choices: room.phase === 'choosing' ? [...round.choices] : null,
        word: round.word,
        nextStrokeId: round.drawing.lastStrokeId + 1,
      };
    }
    if (round.guessed.includes(playerId) && round.word) {
      return { roundId: round.id, choices: null, word: round.word, nextStrokeId: null };
    }
    return null;
  }

  /** Catch-up data for a player joining or rejoining mid-game. */
  gameRestoreFor(room: Room, playerId: string): GameRestore | null {
    if (room.phase === 'match-end') return { privateRound: null, strokes: [], chat: [...room.chat] };
    const round = room.round;
    if (!round || room.phase === 'lobby') return null;
    const knowsWord = room.phase === 'round-end' || round.drawerId === playerId || round.guessed.includes(playerId);
    return {
      privateRound: this.privateRoundFor(room, playerId),
      strokes: cloneStrokes(round.drawing.strokes),
      chat: room.chat.filter((m) => m.scope === 'all' || knowsWord),
    };
  }

  toSnapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      minPlayers: MIN_PLAYERS,
      maxPlayers: this.options.maxPlayersPerRoom,
      round:
        room.round && (room.phase === 'choosing' || room.phase === 'drawing' || room.phase === 'round-end')
          ? this.roundSnapshot(room, room.round)
          : null,
      match: room.match && room.phase !== 'lobby' ? this.matchSnapshot(room, room.match) : null,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        nickname: p.nickname,
        color: p.color,
        isHost: p.id === room.hostId,
        connected: p.socketId !== null,
        joinedAt: p.joinedAt,
      })),
    };
  }

  /** Clears all timers; used on shutdown and in tests. */
  dispose(): void {
    for (const room of this.rooms.values()) {
      this.clearHostHandoff(room);
      this.clearRoundTimer(room);
      this.clearAdvanceTimer(room);
      for (const player of room.players.values()) this.clearRemovalTimer(player);
    }
    this.rooms.clear();
  }

  private requireRoom(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND');
    return room;
  }

  private requireMembership(code: string, playerId: string): Room {
    const room = this.rooms.get(code);
    if (!room || !room.players.has(playerId)) throw new RoomError('NOT_IN_ROOM');
    return room;
  }

  private connectedCount(room: Room): number {
    let count = 0;
    for (const p of room.players.values()) if (p.socketId !== null) count++;
    return count;
  }

  private nextColor(room: Room): string {
    const used = new Set([...room.players.values()].map((p) => p.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[room.players.size % PLAYER_COLORS.length]!;
  }

  private newPlayer(nickname: string, socketId: string, color: string): Player {
    return {
      id: randomUUID(),
      nickname,
      color,
      joinedAt: Date.now(),
      sessionToken: randomBytes(24).toString('base64url'),
      socketId,
      removalTimer: null,
      joinSeq: ++this.joinSeq,
    };
  }

  private requireDrawer(code: string, playerId: string, socketId: string, roundId: unknown): Room {
    const room = this.requireMembership(code, playerId);
    const round = room.round;
    if (room.phase !== 'drawing' || !round || round.id !== roundId) throw new RoomError('INVALID_PHASE');
    if (round.drawerId !== playerId || room.players.get(playerId)!.socketId !== socketId) {
      throw new RoomError('NOT_DRAWER');
    }
    return room;
  }

  /** Fresh match: resets scores, round numbers and results exactly once, then starts round 1. */
  private startMatch(room: Room): void {
    if (this.connectedCount(room) < MIN_PLAYERS) throw new RoomError('NOT_ENOUGH_PLAYERS');
    this.clearRoundTimer(room);
    this.clearAdvanceTimer(room);
    room.round = null;
    room.match = {
      id: ++room.matchCounter,
      roundNumber: 0,
      scores: new Map([...room.players.keys()].map((id) => [id, { score: 0, roundsGuessed: 0, roundsDrawn: 0 }])),
      lastDrawerId: room.lastDrawerId,
      results: [],
      advanceTimer: null,
      advanceAt: null,
      waitingForPlayers: false,
      endReason: null,
    };
    this.startRound(room);
  }

  /**
   * Leaves round-end. Called by the results timer or the host; whichever comes
   * second finds the phase already changed and does nothing.
   */
  private advance(room: Room, by: 'host' | 'timer'): void {
    const match = room.match;
    if (room.phase !== 'round-end' || !match) return;
    this.clearAdvanceTimer(room);
    if (match.roundNumber >= MATCH_ROUNDS) {
      this.finishMatch(room, 'completed');
      return;
    }
    if (this.connectedCount(room) < MIN_PLAYERS) {
      if (by === 'host') throw new RoomError('NOT_ENOUGH_PLAYERS');
      if (room.players.size < MIN_PLAYERS) this.finishMatch(room, 'not-enough-players');
      else match.waitingForPlayers = true;
      return;
    }
    match.waitingForPlayers = false;
    this.startRound(room);
  }

  private finishMatch(room: Room, reason: MatchEndReason): void {
    const match = room.match;
    if (!match || room.phase === 'match-end' || room.phase === 'lobby') return;
    this.clearRoundTimer(room);
    this.clearAdvanceTimer(room);
    match.waitingForPlayers = false;
    match.endReason = reason;
    room.phase = 'match-end';
    const standings = this.standings(room, match);
    const winners = winnersOf(standings).map((id) => room.players.get(id)!.nickname);
    const verdict =
      winners.length === 0 ? 'Nobody scored.' : winners.length === 1 ? `${winners[0]} wins!` : `It's a tie: ${winners.join(' & ')}!`;
    this.postChat(room, {
      kind: 'system',
      text: reason === 'completed' ? `Match over! ${verdict}` : `Match ended early: not enough players. ${verdict}`,
    });
  }

  private scheduleAdvance(room: Room, delayMs: number): void {
    const match = room.match!;
    this.clearAdvanceTimer(room);
    match.advanceAt = Date.now() + delayMs;
    match.advanceTimer = this.safeTimeout(() => {
      match.advanceTimer = null;
      match.advanceAt = null;
      if (room.match !== match) return;
      this.advance(room, 'timer');
      this.options.onRoomChanged?.(room.code);
    }, delayMs);
  }

  private clearAdvanceTimer(room: Room): void {
    const match = room.match;
    if (match?.advanceTimer) {
      clearTimeout(match.advanceTimer);
      match.advanceTimer = null;
    }
    if (match) match.advanceAt = null;
  }

  /** Guesser points by order and time left, plus the drawer's share. Called exactly once per correct guess. */
  private awardGuess(room: Room, round: Round, guesserId: string): number {
    const remaining = round.phaseEndsAt === null ? 0 : round.phaseEndsAt - Date.now();
    const points = guessPoints(round.guessed.length, remaining, round.phaseDurationMs ?? this.options.drawTimeMs);
    const match = room.match;
    const guesser = this.scoreOf(match, guesserId);
    guesser.score += points;
    guesser.roundsGuessed += 1;
    round.points.set(guesserId, (round.points.get(guesserId) ?? 0) + points);
    if (room.players.has(round.drawerId)) {
      this.scoreOf(match, round.drawerId).score += DRAWER_POINTS_PER_GUESS;
      round.points.set(round.drawerId, (round.points.get(round.drawerId) ?? 0) + DRAWER_POINTS_PER_GUESS);
    }
    return points;
  }

  private scoreOf(match: Match | null, playerId: string): PlayerScore {
    if (!match) return { score: 0, roundsGuessed: 0, roundsDrawn: 0 };
    let entry = match.scores.get(playerId);
    if (!entry) {
      entry = { score: 0, roundsGuessed: 0, roundsDrawn: 0 };
      match.scores.set(playerId, entry);
    }
    return entry;
  }

  private standings(room: Room, match: Match) {
    const rows = [...room.players.values()].map((p) => {
      const s = match.scores.get(p.id) ?? { score: 0, roundsGuessed: 0, roundsDrawn: 0 };
      return { playerId: p.id, nickname: p.nickname, color: p.color, ...s };
    });
    return rankByScore(rows);
  }

  private matchSnapshot(room: Room, match: Match): MatchSnapshot {
    const standings = this.standings(room, match);
    const showResult = room.phase === 'round-end' || room.phase === 'match-end';
    return {
      id: match.id,
      roundNumber: match.roundNumber,
      totalRounds: MATCH_ROUNDS,
      standings,
      lastResult: showResult ? (match.results.at(-1) ?? null) : null,
      nextInMs: room.phase === 'round-end' && match.advanceAt !== null ? Math.max(0, match.advanceAt - Date.now()) : null,
      waitingForPlayers: match.waitingForPlayers,
      endReason: match.endReason,
      winnerIds: room.phase === 'match-end' ? winnersOf(standings) : [],
    };
  }

  /** Timers must never take the process down; an exception is logged instead. */
  private safeTimeout(fn: () => void, delayMs: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      try {
        fn();
      } catch (err) {
        console.error('[rooms] timer callback failed', err);
      }
    }, delayMs);
    timer.unref();
    return timer;
  }

  private startRound(room: Room): void {
    const match = room.match;
    if (!match) throw new RoomError('INVALID_PHASE');
    const connected = [...room.players.values()].filter((p) => p.socketId !== null);
    if (connected.length < MIN_PLAYERS) throw new RoomError('NOT_ENOUGH_PLAYERS');

    const candidates = connected.map((p) => ({ id: p.id, joinSeq: p.joinSeq, draws: match.scores.get(p.id)?.roundsDrawn ?? 0 }));
    const drawer = room.players.get(pickDrawer(candidates, match.lastDrawerId, room.lastDrawerSeq).id)!;
    room.lastDrawerSeq = drawer.joinSeq;
    room.lastDrawerId = drawer.id;
    match.lastDrawerId = drawer.id;
    match.roundNumber += 1;
    this.scoreOf(match, drawer.id).roundsDrawn += 1;

    this.clearRoundTimer(room);
    this.clearAdvanceTimer(room);
    room.chat = [];
    // Every *offered* word counts as used: a past drawer must never meet a word they
    // were shown (even one they didn't pick) as a later round's answer.
    const choices = pickWords(WORD_CHOICES, room.usedWords, this.options.words ?? WORDS);
    choices.forEach((w) => room.usedWords.add(w));
    room.round = {
      id: ++room.roundCounter,
      number: match.roundNumber,
      drawerId: drawer.id,
      drawerNickname: drawer.nickname,
      choices,
      word: null,
      phaseEndsAt: null,
      phaseDurationMs: null,
      timer: null,
      guessed: [],
      drawing: emptyStrokeStore(),
      endReason: null,
      points: new Map(),
    };
    room.phase = 'choosing';
    this.setPhaseTimer(room, this.options.wordChoiceMs, () => {
      // The drawer didn't pick in time: pick for them so the round keeps moving.
      const round = room.round!;
      this.beginDrawing(room, round.choices[randomInt(round.choices.length)]!);
    });
    this.postChat(room, {
      kind: 'system',
      text: `Round ${match.roundNumber}/${MATCH_ROUNDS}: ${drawer.nickname} is choosing a word…`,
    });
    this.options.onPrivateRound?.(room.code, drawer.id);
  }

  private beginDrawing(room: Room, word: string): void {
    const round = room.round!;
    round.word = word;
    room.usedWords.add(word);
    room.phase = 'drawing';
    this.setPhaseTimer(room, this.options.drawTimeMs, () => this.endRound(room, 'timeout'));
    const drawer = room.players.get(round.drawerId);
    this.postChat(room, { kind: 'system', text: `${drawer?.nickname ?? 'The drawer'} is drawing. Start guessing!` });
    this.options.onPrivateRound?.(room.code, round.drawerId);
  }

  private endRound(room: Room, reason: RoundEndReason): void {
    const round = room.round;
    if (!round || (room.phase !== 'choosing' && room.phase !== 'drawing')) return;
    this.clearRoundTimer(room);
    round.phaseEndsAt = null;
    round.phaseDurationMs = null;
    round.endReason = reason;
    room.phase = 'round-end';
    const reasonText: Record<RoundEndReason, string> = {
      timeout: "Time's up!",
      'all-guessed': 'Everyone guessed it!',
      'drawer-left': 'The drawer left.',
      'not-enough-players': 'Not enough players left.',
    };
    this.postChat(room, {
      kind: 'system',
      text: round.word ? `${reasonText[reason]} The word was "${round.word}".` : `${reasonText[reason]} Round cancelled.`,
    });

    const match = room.match;
    if (!match) return;
    match.results.push({
      roundNumber: round.number,
      drawerId: round.drawerId,
      drawerNickname: round.drawerNickname,
      word: round.word,
      endReason: reason,
      entries: [...room.players.values()].map((p) => ({
        playerId: p.id,
        nickname: p.nickname,
        points: round.points.get(p.id) ?? 0,
        total: match.scores.get(p.id)?.score ?? 0,
        guessed: round.guessed.includes(p.id),
        isDrawer: p.id === round.drawerId,
      })),
    });
    this.scheduleAdvance(room, this.options.roundResultsMs);
  }

  /** Ends the round once every connected guesser has guessed (and at least one has). */
  private checkAllGuessed(room: Room): void {
    const round = room.round;
    if (!round || room.phase !== 'drawing' || round.guessed.length === 0) return;
    const waiting = [...room.players.values()].some(
      (p) => p.id !== round.drawerId && p.socketId !== null && !round.guessed.includes(p.id),
    );
    if (!waiting) this.endRound(room, 'all-guessed');
  }

  private setPhaseTimer(room: Room, durationMs: number, onExpire: () => void): void {
    const round = room.round!;
    this.clearRoundTimer(room);
    round.phaseDurationMs = durationMs;
    round.phaseEndsAt = Date.now() + durationMs;
    round.timer = this.safeTimeout(() => {
      round.timer = null;
      if (room.round !== round) return;
      onExpire();
      this.options.onRoomChanged?.(room.code);
    }, durationMs);
  }

  private clearRoundTimer(room: Room): void {
    if (room.round?.timer) {
      clearTimeout(room.round.timer);
      room.round.timer = null;
    }
  }

  private roundSnapshot(room: Room, round: Round): NonNullable<RoomSnapshot['round']> {
    const ended = room.phase === 'round-end';
    return {
      id: round.id,
      number: round.number,
      drawerId: round.drawerId,
      remainingMs: round.phaseEndsAt === null ? null : Math.max(0, round.phaseEndsAt - Date.now()),
      durationMs: round.phaseDurationMs,
      hint: room.phase === 'drawing' && round.word ? maskWord(round.word) : null,
      guessedIds: [...round.guessed],
      word: ended ? round.word : null,
      endReason: round.endReason,
      points: Object.fromEntries(round.points),
    };
  }

  private postChat(
    room: Room,
    message: Pick<ChatMessage, 'kind' | 'text'> & Partial<Pick<ChatMessage, 'playerId' | 'nickname' | 'points' | 'withheld'>>,
    scope: ChatMessage['scope'] = 'all',
  ): ChatMessage {
    const full: ChatMessage = {
      id: ++room.chatCounter,
      kind: message.kind,
      playerId: message.playerId ?? null,
      nickname: message.nickname ?? null,
      text: message.text,
      scope,
      at: Date.now(),
      ...(message.points !== undefined ? { points: message.points } : {}),
      ...(message.withheld ? { withheld: true } : {}),
    };
    room.chat.push(full);
    if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.splice(0, room.chat.length - CHAT_HISTORY_LIMIT);
    const round = room.round;
    const audience = scope === 'guessed' && round ? [round.drawerId, ...round.guessed] : null;
    this.options.onChat?.(room.code, full, audience);
    return full;
  }

  /** After a delay, moves host from a still-disconnected host to the first connected player. */
  private scheduleHostHandoff(room: Room): void {
    this.clearHostHandoff(room);
    room.hostHandoffTimer = this.safeTimeout(() => {
      room.hostHandoffTimer = null;
      const host = room.players.get(room.hostId);
      if (!host || host.socketId !== null) return;
      const next = [...room.players.values()].find((p) => p.socketId !== null);
      if (!next) return;
      room.hostId = next.id;
      this.options.onRoomChanged?.(room.code);
    }, this.options.hostHandoffMs);
  }

  private clearHostHandoff(room: Room): void {
    if (room.hostHandoffTimer) {
      clearTimeout(room.hostHandoffTimer);
      room.hostHandoffTimer = null;
    }
  }

  private clearRemovalTimer(player: Player): void {
    if (player.removalTimer) {
      clearTimeout(player.removalTimer);
      player.removalTimer = null;
    }
  }
}
