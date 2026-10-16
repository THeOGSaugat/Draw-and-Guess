import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@draw-guess/shared';
import { RoomError } from '../src/rooms/RoomError.js';
import { RoomManager } from '../src/rooms/RoomManager.js';

const managers: RoomManager[] = [];
function makeManager(overrides: Partial<ConstructorParameters<typeof RoomManager>[0]> = {}) {
  const m = new RoomManager({ maxPlayersPerRoom: 8, maxRooms: 100, reconnectGraceMs: 50, hostHandoffMs: 25, wordChoiceMs: 5000, drawTimeMs: 5000, roundResultsMs: 5000, ...overrides });
  managers.push(m);
  return m;
}
afterEach(() => managers.splice(0).forEach((m) => m.dispose()));

function assertRoomError(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => err instanceof RoomError && err.code === code);
}

describe('RoomManager', () => {
  it('creates rooms with unique, well-formed codes and the creator as host', () => {
    const m = makeManager();
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { room, player } = m.createRoom(`Player${i}`, `s${i}`);
      assert.equal(room.code.length, ROOM_CODE_LENGTH);
      assert.ok([...room.code].every((c) => ROOM_CODE_ALPHABET.includes(c)));
      assert.equal(room.hostId, player.id);
      codes.add(room.code);
    }
    assert.equal(codes.size, 50);
  });

  it('rejects unknown rooms, duplicate nicknames (case-insensitive) and full rooms', () => {
    const m = makeManager({ maxPlayersPerRoom: 3 });
    const { room } = m.createRoom('Alice', 's1');
    assertRoomError(() => m.joinRoom('ZZZZZ', 'Bob', 's2'), 'ROOM_NOT_FOUND');
    assertRoomError(() => m.joinRoom(room.code, 'aLiCe', 's2'), 'NICKNAME_TAKEN');
    m.joinRoom(room.code, 'Bob', 's2');
    m.joinRoom(room.code, 'Cara', 's3');
    assertRoomError(() => m.joinRoom(room.code, 'Dan', 's4'), 'ROOM_FULL');
  });

  it('assigns distinct colors to players', () => {
    const m = makeManager();
    const { room } = m.createRoom('Alice', 's1');
    m.joinRoom(room.code, 'Bob', 's2');
    m.joinRoom(room.code, 'Cara', 's3');
    const colors = [...room.players.values()].map((p) => p.color);
    assert.equal(new Set(colors).size, 3);
  });

  it('only lets the host start, and only with 2+ connected players', () => {
    const m = makeManager();
    const { room, player: host } = m.createRoom('Alice', 's1');
    assertRoomError(() => m.startGame(room.code, host.id), 'NOT_ENOUGH_PLAYERS');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 's2');
    assertRoomError(() => m.startGame(room.code, bob.id), 'NOT_HOST');
    m.startGame(room.code, host.id);
    assert.equal(room.phase, 'choosing');
    assertRoomError(() => m.joinRoom(room.code, 'Cara', 's3'), 'GAME_IN_PROGRESS');
    m.returnToLobby(room.code, host.id);
    assert.equal(room.phase, 'lobby');
  });

  it('hands host to the next player and deletes empty rooms', () => {
    const m = makeManager();
    const { room, player: host } = m.createRoom('Alice', 's1');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 's2');
    m.removePlayer(room.code, host.id);
    assert.equal(room.hostId, bob.id);
    m.removePlayer(room.code, bob.id);
    assert.equal(m.getRoom(room.code), undefined);
  });

  it('keeps a disconnected seat during the grace period and allows rejoin', async () => {
    const m = makeManager({ reconnectGraceMs: 30 });
    const { room, player } = m.createRoom('Alice', 's1');
    m.joinRoom(room.code, 'Bob', 's2');
    m.markDisconnected(room.code, player.id, 's1');
    assert.equal(m.toSnapshot(room).players[0]?.connected, false);

    const rejoined = m.rejoinRoom(room.code, player.sessionToken, 's1b');
    assert.equal(rejoined.player.id, player.id);
    assert.equal(rejoined.previousSocketId, null);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(room.players.has(player.id), 'rejoined player must not be removed by stale timer');
  });

  it('removes a disconnected player after the grace period and notifies', async () => {
    const changed: string[] = [];
    const m = makeManager({ reconnectGraceMs: 20, onRoomChanged: (c) => changed.push(c) });
    const { room, player: host } = m.createRoom('Alice', 's1');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 's2');
    m.markDisconnected(room.code, host.id, 's1');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!room.players.has(host.id));
    assert.equal(room.hostId, bob.id);
    assert.deepEqual(changed, [room.code]);
    assertRoomError(() => m.rejoinRoom(room.code, host.sessionToken, 's1c'), 'SESSION_EXPIRED');
  });

  it('ignores stale disconnects from a replaced socket', () => {
    const m = makeManager();
    const { room, player } = m.createRoom('Alice', 's1');
    const { previousSocketId } = m.rejoinRoom(room.code, player.sessionToken, 's1-new');
    assert.equal(previousSocketId, 's1');
    m.markDisconnected(room.code, player.id, 's1');
    assert.equal(m.toSnapshot(room).players[0]?.connected, true);
  });

  it('hands host to a connected player shortly after the host disconnects', async () => {
    const changed: string[] = [];
    const m = makeManager({ reconnectGraceMs: 1000, hostHandoffMs: 20, onRoomChanged: (c) => changed.push(c) });
    const { room, player: host } = m.createRoom('Alice', 's1');
    const { player: bob } = m.joinRoom(room.code, 'Bob', 's2');
    m.markDisconnected(room.code, host.id, 's1');
    assert.equal(room.hostId, host.id, 'brief blips must not move the host');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(room.hostId, bob.id);
    assert.ok(room.players.has(host.id), 'old host keeps their seat during the grace period');
    assert.deepEqual(changed, [room.code]);
  });

  it('keeps the host if they reconnect before the hand-off delay', async () => {
    const m = makeManager({ reconnectGraceMs: 1000, hostHandoffMs: 30 });
    const { room, player: host } = m.createRoom('Alice', 's1');
    m.joinRoom(room.code, 'Bob', 's2');
    m.markDisconnected(room.code, host.id, 's1');
    m.rejoinRoom(room.code, host.sessionToken, 's1b');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(room.hostId, host.id);
  });

  it('enforces the server-wide room cap', () => {
    const m = makeManager({ maxRooms: 1 });
    m.createRoom('Alice', 's1');
    assertRoomError(() => m.createRoom('Bob', 's2'), 'SERVER_FULL');
  });
});
