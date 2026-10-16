import { gameError, type AckResult, type JoinedRoom } from '@draw-guess/shared';
import { RoomError } from '../rooms/RoomError.js';
import type { RoomManager, Seat } from '../rooms/RoomManager.js';
import { createRateLimiter } from './rateLimit.js';
import type { GameServer, GameSocket } from './types.js';
import { asObject, readNickname, readRoomCode, readSessionToken } from './validate.js';

const RATE_LIMIT = { events: 30, windowMs: 10_000 };

export function registerSocketHandlers(io: GameServer, rooms: RoomManager): void {
  const broadcastRoom = (code: string) => {
    const room = rooms.getRoom(code);
    if (room) io.to(code).emit('room:state', rooms.toSnapshot(room));
  };

  io.on('connection', (socket: GameSocket) => {
    socket.data.playerId = null;
    socket.data.roomCode = null;
    const allowEvent = createRateLimiter(RATE_LIMIT.events, RATE_LIMIT.windowMs);

    /**
     * Runs a handler and always answers through the ack callback. Events
     * without a callback are dropped: every client event requires one.
     */
    const respond = <T>(ack: unknown, handler: () => T) => {
      if (typeof ack !== 'function') return;
      const reply = ack as (result: AckResult<T>) => void;
      if (!allowEvent()) return reply({ ok: false, error: gameError('RATE_LIMITED') });
      try {
        reply({ ok: true, data: handler() });
      } catch (err) {
        if (err instanceof RoomError) {
          reply({ ok: false, error: gameError(err.code, err.message) });
        } else {
          console.error(`[socket ${socket.id}] unexpected error`, err);
          reply({ ok: false, error: gameError('INTERNAL') });
        }
      }
    };

    const seat = (s: Seat): JoinedRoom => {
      socket.data.playerId = s.player.id;
      socket.data.roomCode = s.room.code;
      void socket.join(s.room.code);
      broadcastRoom(s.room.code);
      return { room: rooms.toSnapshot(s.room), playerId: s.player.id, sessionToken: s.player.sessionToken };
    };

    const leaveCurrentRoom = () => {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;
      rooms.removePlayer(roomCode, playerId);
      void socket.leave(roomCode);
      socket.data.playerId = null;
      socket.data.roomCode = null;
      broadcastRoom(roomCode);
    };

    const requireSeat = () => {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) throw new RoomError('NOT_IN_ROOM');
      return { roomCode, playerId };
    };

    socket.on('room:create', (payload: unknown, ack: unknown) =>
      respond(ack, () => {
        const nickname = readNickname(asObject(payload));
        // Create first so a failure (e.g. SERVER_FULL) doesn't cost the player their current seat.
        const created = rooms.createRoom(nickname, socket.id);
        leaveCurrentRoom();
        return seat(created);
      }),
    );

    socket.on('room:join', (payload: unknown, ack: unknown) =>
      respond(ack, () => {
        const body = asObject(payload);
        const code = readRoomCode(body);
        const nickname = readNickname(body);
        if (socket.data.roomCode === code) throw new RoomError('ALREADY_IN_ROOM');
        // Validate against the target room before abandoning the current one.
        const joined = rooms.joinRoom(code, nickname, socket.id);
        leaveCurrentRoom();
        return seat(joined);
      }),
    );

    socket.on('room:rejoin', (payload: unknown, ack: unknown) =>
      respond(ack, () => {
        const body = asObject(payload);
        const code = readRoomCode(body);
        const token = readSessionToken(body);
        // Validate before touching the current seat, then release it if this is a different one.
        const target = rooms.findSeat(code, token);
        if (socket.data.playerId !== target.player.id) leaveCurrentRoom();
        const { previousSocketId, ...joined } = rooms.rejoinRoom(code, token, socket.id);
        if (previousSocketId) {
          const previous = io.sockets.sockets.get(previousSocketId);
          if (previous) {
            previous.data.playerId = null;
            previous.data.roomCode = null;
            void previous.leave(code);
            previous.emit('session:replaced');
          }
        }
        return seat(joined);
      }),
    );

    socket.on('room:leave', (ack: unknown) =>
      respond(ack, () => {
        leaveCurrentRoom();
        return null;
      }),
    );

    socket.on('game:start', (ack: unknown) =>
      respond(ack, () => {
        const { roomCode, playerId } = requireSeat();
        rooms.startGame(roomCode, playerId);
        broadcastRoom(roomCode);
        return null;
      }),
    );

    socket.on('game:returnToLobby', (ack: unknown) =>
      respond(ack, () => {
        const { roomCode, playerId } = requireSeat();
        rooms.returnToLobby(roomCode, playerId);
        broadcastRoom(roomCode);
        return null;
      }),
    );

    socket.on('disconnect', () => {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;
      rooms.markDisconnected(roomCode, playerId, socket.id);
      broadcastRoom(roomCode);
    });
  });
}
