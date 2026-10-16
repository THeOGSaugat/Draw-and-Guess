/**
 * Drawing + round contract shared by client and server.
 *
 * Coordinates are integers in [0, COORD_MAX] on a square canvas, so drawings
 * look identical on every screen size and pixel density.
 */
export const COORD_MAX = 2000;

/** Canvas background; the eraser paints with this color. */
export const CANVAS_BACKGROUND = '#ffffff';

export const BRUSH_COLORS = [
  { value: '#1f2333', name: 'Black' },
  { value: '#6b7280', name: 'Gray' },
  { value: '#ef4444', name: 'Red' },
  { value: '#f97316', name: 'Orange' },
  { value: '#facc15', name: 'Yellow' },
  { value: '#22c55e', name: 'Green' },
  { value: '#3b82f6', name: 'Blue' },
  { value: '#8b5cf6', name: 'Purple' },
  { value: '#ec4899', name: 'Pink' },
  { value: '#92400e', name: 'Brown' },
] as const;

/** Brush diameters in coordinate units (1/COORD_MAX of the canvas width). */
export const BRUSH_SIZES = [
  { value: 8, name: 'Thin' },
  { value: 18, name: 'Medium' },
  { value: 36, name: 'Thick' },
  { value: 70, name: 'Huge' },
] as const;

export const DRAW_LIMITS = {
  opsPerBatch: 64,
  pointsPerOp: 256,
  pointsPerStroke: 4000,
  strokesPerRound: 3000,
  pointsPerRound: 60_000,
} as const;

export const WORD_CHOICES = 3;

/** A match is exactly this many rounds. */
export const MATCH_ROUNDS = 5;

/**
 * Scoring (server-calculated; documented in README):
 *   guesser = max(guessBaseMin, guessBaseFirst − guessBaseStep × (order − 1))
 *           + round(speedBonusMax × timeLeft / drawTime)        → at most 100
 *   drawer  = drawerPerGuess for every player who guesses correctly
 */
export const SCORING = {
  guessBaseFirst: 50,
  guessBaseStep: 10,
  guessBaseMin: 20,
  speedBonusMax: 50,
  drawerPerGuess: 25,
} as const;
export const CHAT_MAX_LENGTH = 100;

export type DrawTool = 'pen' | 'eraser';

export type DrawOp =
  | { t: 'begin'; id: number; tool: DrawTool; color: string; size: number; x: number; y: number }
  /** Flat list of coordinates: [x0, y0, x1, y1, ...]. */
  | { t: 'points'; id: number; pts: number[] }
  | { t: 'end'; id: number };

export interface DrawOpsPayload {
  roundId: number;
  ops: DrawOp[];
}

export interface Stroke {
  id: number;
  tool: DrawTool;
  color: string;
  size: number;
  /** Flat list of coordinates: [x0, y0, x1, y1, ...]. */
  pts: number[];
  done: boolean;
}

export type RoundEndReason = 'timeout' | 'all-guessed' | 'drawer-left' | 'not-enough-players';

/** Public round state. Never contains the secret word until the round has ended. */
export interface RoundSnapshot {
  id: number;
  /** 1-based round number within the match. */
  number: number;
  drawerId: string;
  /** Time left in the current phase (choosing or drawing), measured when the snapshot was sent. */
  remainingMs: number | null;
  /** Full length of the current phase, for progress bars. */
  durationMs: number | null;
  /** Masked word, e.g. "___ _____". Only while drawing. */
  hint: string | null;
  /** Players who have guessed correctly, in order. */
  guessedIds: string[];
  /** Revealed only once the round has ended. */
  word: string | null;
  endReason: RoundEndReason | null;
  /** Points earned so far this round, by player id. */
  points: Record<string, number>;
}

export type MatchEndReason = 'completed' | 'not-enough-players';

/** One row of the standings, ranked by score (ties share a rank: 1, 1, 3). */
export interface Standing {
  playerId: string;
  nickname: string;
  color: string;
  score: number;
  rank: number;
  roundsGuessed: number;
  roundsDrawn: number;
}

export interface RoundResultEntry {
  playerId: string;
  nickname: string;
  /** Points earned in this round. */
  points: number;
  /** Total after this round. */
  total: number;
  guessed: boolean;
  isDrawer: boolean;
}

/** Summary of a finished round. Only exists once the word has been revealed. */
export interface RoundResult {
  roundNumber: number;
  drawerId: string;
  drawerNickname: string;
  word: string | null;
  endReason: RoundEndReason;
  entries: RoundResultEntry[];
}

export interface MatchSnapshot {
  id: number;
  roundNumber: number;
  totalRounds: number;
  /** Current players ranked by score. Players who left the room are not ranked. */
  standings: Standing[];
  /** The most recent round's results (round-end and match-end only). */
  lastResult: RoundResult | null;
  /** Time until the match advances automatically (round-end only). */
  nextInMs: number | null;
  /** Round-end is paused because fewer than 2 players are connected. */
  waitingForPlayers: boolean;
  /** Set once the match is over. */
  endReason: MatchEndReason | null;
  /** Rank-1 players with a score above zero (several on a tie; none if nobody scored). */
  winnerIds: string[];
}

/** Sent only to one player: the drawer's choices/word, or the word for players who guessed it. */
export interface PrivateRoundInfo {
  roundId: number;
  choices: string[] | null;
  word: string | null;
  /** Drawer only: the next stroke id the server will accept (ids must keep increasing, even across clears). */
  nextStrokeId: number | null;
}

export interface ChatMessage {
  id: number;
  kind: 'chat' | 'correct' | 'system';
  playerId: string | null;
  nickname: string | null;
  text: string;
  /** 'guessed' messages are only visible to the drawer and players who already guessed. */
  scope: 'all' | 'guessed';
  at: number;
  /** For 'correct' messages: points the guesser earned. */
  points?: number;
  /** Shown only to players who know the word because it contained the answer. */
  withheld?: boolean;
}

/** Everything a (re)joining player needs to catch up with a round in progress. */
export interface GameRestore {
  privateRound: PrivateRoundInfo | null;
  strokes: Stroke[];
  chat: ChatMessage[];
}

export interface ChatResult {
  status: 'sent' | 'correct';
}
