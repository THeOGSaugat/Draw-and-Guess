import type { AckResult } from './errors.js';
import type { ChatMessage, ChatResult, DrawOpsPayload, PrivateRoundInfo } from './game.js';
import type { JoinedRoom, RoomSnapshot } from './types.js';

export type Ack<T> = (result: AckResult<T>) => void;

export interface CreateRoomPayload {
  nickname: string;
}

export interface JoinRoomPayload {
  code: string;
  nickname: string;
}

export interface RejoinRoomPayload {
  code: string;
  sessionToken: string;
}

/**
 * Client → server events. Every event takes an acknowledgement callback so the
 * client always learns whether the server accepted the request.
 * The server must still treat all arguments as untrusted input.
 */
export interface ClientToServerEvents {
  'room:create': (payload: CreateRoomPayload, ack: Ack<JoinedRoom>) => void;
  'room:join': (payload: JoinRoomPayload, ack: Ack<JoinedRoom>) => void;
  'room:rejoin': (payload: RejoinRoomPayload, ack: Ack<JoinedRoom>) => void;
  'room:leave': (ack: Ack<null>) => void;
  'game:start': (ack: Ack<null>) => void;
  'game:returnToLobby': (ack: Ack<null>) => void;
  /** Host skips the results countdown: next round, or the final results after round 5. */
  'round:next': (ack: Ack<null>) => void;
  /** Host starts a fresh match from the final leaderboard. */
  'match:playAgain': (ack: Ack<null>) => void;
  /** Drawer picks one of their word choices (0-based index). */
  'round:chooseWord': (payload: { index: number }, ack: Ack<null>) => void;
  'chat:send': (payload: { text: string }, ack: Ack<ChatResult>) => void;
  /**
   * Drawer's stroke operations, batched. The only fire-and-forget event: it is
   * sent many times per second, so it has its own rate limit instead of an ack.
   */
  'draw:ops': (payload: DrawOpsPayload) => void;
  'draw:clear': (payload: { roundId: number }, ack: Ack<null>) => void;
}

/** Server → client events. */
export interface ServerToClientEvents {
  /** Full authoritative room state; sent whenever anything in the room changes. */
  'room:state': (room: RoomSnapshot) => void;
  /** This seat was claimed by another tab/connection using the same session. */
  'session:replaced': () => void;
  /** Private round data for this player only (word choices, or the word once known). */
  'round:private': (info: PrivateRoundInfo) => void;
  'chat:message': (message: ChatMessage) => void;
  /** Stroke operations from the drawer, in the order the server received them. */
  'draw:ops': (payload: DrawOpsPayload) => void;
  'draw:clear': (payload: { roundId: number }) => void;
}
