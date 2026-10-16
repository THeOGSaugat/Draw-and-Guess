import type { ClientToServerEvents, ServerToClientEvents } from '@draw-guess/shared';
import { io, type Socket } from 'socket.io-client';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const serverUrl = import.meta.env.VITE_SERVER_URL?.trim();
const options = { autoConnect: false };

/** Single shared connection. Same-origin by default (Vite proxies in dev). */
export const socket: GameSocket = serverUrl ? io(serverUrl, options) : io(options);
