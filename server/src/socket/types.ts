import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@draw-guess/shared';

/** Per-connection server-side state. */
export interface SocketData {
  playerId: string | null;
  roomCode: string | null;
}

type InterServerEvents = {};

export type GameServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
