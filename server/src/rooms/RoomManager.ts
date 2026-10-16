import { randomBytes, randomUUID } from 'node:crypto';
import {
  MIN_PLAYERS,
  PLAYER_COLORS,
  nicknameKey,
  type RoomPhase,
  type RoomSnapshot,
} from '@draw-guess/shared';
import { RoomError } from './RoomError.js';
import { generateRoomCode } from './roomCode.js';

export interface Player {
  id: string;
  nickname: string;
  color: string;
  joinedAt: number;
  /** Secret that lets this player reclaim their seat. Never broadcast. */
  sessionToken: string;
  /** Socket currently attached to this seat, or null while disconnected. */
  socketId: string | null;
  removalTimer: NodeJS.Timeout | null;
}

export interface Room {
  code: string;
  phase: RoomPhase;
  hostId: string;
  /** Insertion order == join order, which drives host hand-off. */
  players: Map<string, Player>;
  createdAt: number;
  /** Pending transfer of host away from a disconnected host. */
  hostHandoffTimer: NodeJS.Timeout | null;
}

export interface RoomManagerOptions {
  maxPlayersPerRoom: number;
  maxRooms: number;
  reconnectGraceMs: number;
  /** How long a disconnected host keeps the host role before it moves to a connected player. */
  hostHandoffMs: number;
  /** Called when a room changes outside a request (e.g. grace-period expiry). */
  onRoomChanged?: (code: string) => void;
}

export interface Seat {
  room: Room;
  player: Player;
}

/**
 * Authoritative in-memory room state. Knows nothing about sockets so it can be
 * unit-tested directly; the socket layer translates events into these calls.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly options: RoomManagerOptions) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) count += room.players.size;
    return count;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  createRoom(nickname: string, socketId: string): Seat {
    if (this.rooms.size >= this.options.maxRooms) throw new RoomError('SERVER_FULL');

    const code = generateRoomCode((c) => this.rooms.has(c));
    const player = this.newPlayer(nickname, socketId, PLAYER_COLORS[0]);
    const room: Room = {
      code,
      phase: 'lobby',
      hostId: player.id,
      players: new Map([[player.id, player]]),
      createdAt: Date.now(),
      hostHandoffTimer: null,
    };
    this.rooms.set(code, room);
    return { room, player };
  }

  joinRoom(code: string, nickname: string, socketId: string): Seat {
    const room = this.requireRoom(code);
    if (room.phase !== 'lobby') throw new RoomError('GAME_IN_PROGRESS');
    if (room.players.size >= this.options.maxPlayersPerRoom) throw new RoomError('ROOM_FULL');

    const key = nicknameKey(nickname);
    for (const other of room.players.values()) {
      if (nicknameKey(other.nickname) === key) throw new RoomError('NICKNAME_TAKEN');
    }

    const player = this.newPlayer(nickname, socketId, this.nextColor(room));
    room.players.set(player.id, player);
    return { room, player };
  }

  /** Looks up a seat by its session token without changing anything. */
  findSeat(code: string, sessionToken: string): Seat {
    const room = this.rooms.get(code);
    const player = room && [...room.players.values()].find((p) => p.sessionToken === sessionToken);
    if (!room || !player) throw new RoomError('SESSION_EXPIRED');
    return { room, player };
  }

  /**
   * Re-attaches a socket to an existing seat. Returns the socket id previously
   * attached (if any) so the caller can tell that connection it was replaced.
   */
  rejoinRoom(code: string, sessionToken: string, socketId: string): Seat & { previousSocketId: string | null } {
    const { room, player } = this.findSeat(code, sessionToken);
    this.clearRemovalTimer(player);
    if (room.hostId === player.id) this.clearHostHandoff(room);
    const previousSocketId = player.socketId !== socketId ? player.socketId : null;
    player.socketId = socketId;
    return { room, player, previousSocketId };
  }

  /** Marks the player as disconnected and starts their grace period. */
  markDisconnected(code: string, playerId: string, socketId: string): void {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    // Ignore stale disconnects from a socket that has already been replaced.
    if (!room || !player || player.socketId !== socketId) return;

    player.socketId = null;
    this.clearRemovalTimer(player);
    player.removalTimer = setTimeout(() => {
      player.removalTimer = null;
      if (player.socketId !== null) return;
      this.removePlayer(code, playerId);
      this.options.onRoomChanged?.(code);
    }, this.options.reconnectGraceMs);
    player.removalTimer.unref();

    if (room.hostId === playerId) this.scheduleHostHandoff(room);
  }

  /** Removes a player immediately, handing off host and deleting empty rooms. */
  removePlayer(code: string, playerId: string): void {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player) return;

    this.clearRemovalTimer(player);
    room.players.delete(playerId);

    if (room.players.size === 0) {
      this.clearHostHandoff(room);
      this.rooms.delete(code);
      return;
    }
    if (room.hostId === playerId) {
      this.clearHostHandoff(room);
      // Prefer the longest-standing connected player; fall back to anyone.
      const players = [...room.players.values()];
      const next = players.find((p) => p.socketId !== null) ?? players[0]!;
      room.hostId = next.id;
      if (next.socketId === null) this.scheduleHostHandoff(room);
    }
    // Phase 1 has no game to keep alive; drop back to the lobby if too few remain.
    if (room.phase === 'in-game' && room.players.size < MIN_PLAYERS) room.phase = 'lobby';
  }

  startGame(code: string, playerId: string): Room {
    const room = this.requireMembership(code, playerId);
    if (room.hostId !== playerId) throw new RoomError('NOT_HOST');
    if (room.phase !== 'lobby') throw new RoomError('GAME_IN_PROGRESS');
    if (this.connectedCount(room) < MIN_PLAYERS) throw new RoomError('NOT_ENOUGH_PLAYERS');
    room.phase = 'in-game';
    return room;
  }

  returnToLobby(code: string, playerId: string): Room {
    const room = this.requireMembership(code, playerId);
    if (room.hostId !== playerId) throw new RoomError('NOT_HOST');
    room.phase = 'lobby';
    return room;
  }

  toSnapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      minPlayers: MIN_PLAYERS,
      maxPlayers: this.options.maxPlayersPerRoom,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        nickname: p.nickname,
        color: p.color,
        isHost: p.id === room.hostId,
        connected: p.socketId !== null,
        joinedAt: p.joinedAt,
      })),
    };
  }

  /** Clears all timers; used on shutdown and in tests. */
  dispose(): void {
    for (const room of this.rooms.values()) {
      this.clearHostHandoff(room);
      for (const player of room.players.values()) this.clearRemovalTimer(player);
    }
    this.rooms.clear();
  }

  private requireRoom(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND');
    return room;
  }

  private requireMembership(code: string, playerId: string): Room {
    const room = this.rooms.get(code);
    if (!room || !room.players.has(playerId)) throw new RoomError('NOT_IN_ROOM');
    return room;
  }

  private connectedCount(room: Room): number {
    let count = 0;
    for (const p of room.players.values()) if (p.socketId !== null) count++;
    return count;
  }

  private nextColor(room: Room): string {
    const used = new Set([...room.players.values()].map((p) => p.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[room.players.size % PLAYER_COLORS.length]!;
  }

  private newPlayer(nickname: string, socketId: string, color: string): Player {
    return {
      id: randomUUID(),
      nickname,
      color,
      joinedAt: Date.now(),
      sessionToken: randomBytes(24).toString('base64url'),
      socketId,
      removalTimer: null,
    };
  }

  /** After a delay, moves host from a still-disconnected host to the first connected player. */
  private scheduleHostHandoff(room: Room): void {
    this.clearHostHandoff(room);
    room.hostHandoffTimer = setTimeout(() => {
      room.hostHandoffTimer = null;
      const host = room.players.get(room.hostId);
      if (!host || host.socketId !== null) return;
      const next = [...room.players.values()].find((p) => p.socketId !== null);
      if (!next) return;
      room.hostId = next.id;
      this.options.onRoomChanged?.(room.code);
    }, this.options.hostHandoffMs);
    room.hostHandoffTimer.unref();
  }

  private clearHostHandoff(room: Room): void {
    if (room.hostHandoffTimer) {
      clearTimeout(room.hostHandoffTimer);
      room.hostHandoffTimer = null;
    }
  }

  private clearRemovalTimer(player: Player): void {
    if (player.removalTimer) {
      clearTimeout(player.removalTimer);
      player.removalTimer = null;
    }
  }
}
