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

type AppConfig = Pick<
  Config,
  | 'corsOrigins'
  | 'maxPlayersPerRoom'
  | 'maxRooms'
  | 'reconnectGraceMs'
  | 'hostHandoffMs'
  | 'wordChoiceMs'
  | 'drawTimeMs'
  | 'roundResultsMs'
> & {
  clientDistDir?: string;
  /** Word list override (tests). */
  words?: readonly string[];
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
    wordChoiceMs: config.wordChoiceMs,
    drawTimeMs: config.drawTimeMs,
    roundResultsMs: config.roundResultsMs,
    words: config.words,
    onRoomChanged: (code) => {
      const room = rooms.getRoom(code);
      if (room) io.to(code).emit('room:state', rooms.toSnapshot(room));
    },
    onPrivateRound: (code, playerId) => {
      const room = rooms.getRoom(code);
      const socketId = room?.players.get(playerId)?.socketId;
      const info = room && rooms.privateRoundFor(room, playerId);
      if (socketId && info) io.to(socketId).emit('round:private', info);
    },
    onChat: (code, message, audience) => {
      const room = rooms.getRoom(code);
      if (!room) return;
      if (audience === null) {
        io.to(code).emit('chat:message', message);
        return;
      }
      // Restricted messages go to each entitled player's own socket only.
      const socketIds = audience
        .map((id) => room.players.get(id)?.socketId)
        .filter((id): id is string => typeof id === 'string');
      if (socketIds.length > 0) io.to(socketIds).emit('chat:message', message);
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
