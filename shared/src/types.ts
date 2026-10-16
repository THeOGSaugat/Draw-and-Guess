export type RoomPhase = 'lobby' | 'in-game';

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
}

/** Returned only to the player who created/joined/rejoined. */
export interface JoinedRoom {
  room: RoomSnapshot;
  playerId: string;
  /** Secret used to reclaim this seat after a reload or dropped connection. */
  sessionToken: string;
}
