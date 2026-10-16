import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import type { Config } from './config.js';
import { RoomManager } from './rooms/RoomManager.js';
import { registerSocketHandlers } from './socket/registerHandlers.js';
import type { GameServer } from './socket/types.js';

export interface AppInstance {
  httpServer: HttpServer;
  io: GameServer;
  rooms: RoomManager;
}

type AppConfig = Pick<Config, 'corsOrigins' | 'maxPlayersPerRoom' | 'maxRooms' | 'reconnectGraceMs' | 'hostHandoffMs'> & {
  clientDistDir?: string;
};

export function createApp(config: AppConfig): AppInstance {
  const startedAt = Date.now();
  const app = express();
  app.disable('x-powered-by');

  const httpServer = createServer(app);
  const io: GameServer = new Server(httpServer, {
    // Same-origin by default (Vite proxies in dev); extra origins are opt-in.
    cors: config.corsOrigins.length > 0 ? { origin: config.corsOrigins } : undefined,
    maxHttpBufferSize: 100_000,
  });

  const rooms = new RoomManager({
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    maxRooms: config.maxRooms,
    reconnectGraceMs: config.reconnectGraceMs,
    hostHandoffMs: config.hostHandoffMs,
    onRoomChanged: (code) => {
      const room = rooms.getRoom(code);
      if (room) io.to(code).emit('room:state', rooms.toSnapshot(room));
    },
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      rooms: rooms.roomCount,
      players: rooms.playerCount,
      connections: io.engine.clientsCount,
    });
  });

  // In production, serve the built client from the same origin.
  if (config.clientDistDir && existsSync(join(config.clientDistDir, 'index.html'))) {
    const dist = config.clientDistDir;
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
      res.sendFile(join(dist, 'index.html'));
    });
  }

  registerSocketHandlers(io, rooms);
  return { httpServer, io, rooms };
}
