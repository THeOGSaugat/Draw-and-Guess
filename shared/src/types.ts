import type { GameRestore, MatchSnapshot, RoundSnapshot } from './game.js';

/**
 * Server-side state machine:
 * lobby → choosing → drawing → round-end → (choosing | match-end) → (choosing [play again] | lobby).
 */
export type RoomPhase = 'lobby' | 'choosing' | 'drawing' | 'round-end' | 'match-end';

/** Player data that is safe to broadcast to everyone in the room. */
export interface PublicPlayer {
  id: string;
  nickname: string;
  color: string;
  isHost: boolean;
  connected: boolean;
  joinedAt: number;
}

/** Authoritative room snapshot, broadcast after every change. */
export interface RoomSnapshot {
  code: string;
  phase: RoomPhase;
  hostId: string;
  players: PublicPlayer[];
  minPlayers: number;
  maxPlayers: number;
  /** Current or just-finished round; null in the lobby and once the match is over. */
  round: RoundSnapshot | null;
  /** The match in progress or just finished; null in the lobby. */
  match: MatchSnapshot | null;
}

/** Returned only to the player who created/joined/rejoined. */
export interface JoinedRoom {
  room: RoomSnapshot;
  playerId: string;
  /** Secret used to reclaim this seat after a reload or dropped connection. */
  sessionToken: string;
  /** Catch-up data when joining or rejoining a room that is mid-game. */
  game: GameRestore | null;
}
