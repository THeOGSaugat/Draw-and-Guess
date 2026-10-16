import type { AckResult } from './errors.js';
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
}

/** Server → client events. */
export interface ServerToClientEvents {
  /** Full authoritative room state; sent whenever anything in the room changes. */
  'room:state': (room: RoomSnapshot) => void;
  /** This seat was claimed by another tab/connection using the same session. */
  'session:replaced': () => void;
}
