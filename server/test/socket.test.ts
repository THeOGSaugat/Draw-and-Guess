import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type {
  AckResult,
  ClientToServerEvents,
  JoinedRoom,
  RoomSnapshot,
  ServerToClientEvents,
} from '@draw-guess/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { createApp, type AppInstance } from '../src/createApp.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let app: AppInstance;
let url: string;
const clients: Client[] = [];

before(async () => {
  app = createApp({ corsOrigins: [], maxPlayersPerRoom: 3, maxRooms: 50, reconnectGraceMs: 200, hostHandoffMs: 100, wordChoiceMs: 5000, drawTimeMs: 5000, roundResultsMs: 5000 });
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  clients.forEach((c) => c.disconnect());
  app.rooms.dispose();
  await app.io.close();
});

async function client(): Promise<Client> {
  const c: Client = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(c);
  await new Promise<void>((resolve, reject) => {
    c.once('connect', resolve);
    c.once('connect_error', reject);
  });
  return c;
}

function nextState(c: Client): Promise<RoomSnapshot> {
  return new Promise((resolve) => c.once('room:state', resolve));
}

// Socket.IO's typed emit doesn't allow arbitrary payloads, so tests that send
// malformed data go through this untyped helper.
function emitRaw<T>(c: Client, event: string, ...args: unknown[]): Promise<AckResult<T>> {
  return new Promise((resolve) => (c.emit as (...a: unknown[]) => void)(event, ...args, resolve));
}

function ok<T>(result: AckResult<T>): T {
  if (!result.ok) assert.fail(`expected ok, got ${result.error.code}`);
  return result.data;
}

function errorCode(result: AckResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe('socket flow', () => {
  it('serves the health endpoint', async () => {
    const res = await fetch(`${url}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'ok');
  });

  it('creates, joins, validates, starts and handles leaving', async () => {
    const alice = await client();
    const created = ok(await emitRaw<JoinedRoom>(alice, 'room:create', { nickname: '  Alice  ' }));
    assert.equal(created.room.players[0]?.nickname, 'Alice');
    assert.equal(created.room.players[0]?.isHost, true);
    const code = created.room.code;

    const bob = await client();
    const aliceSeesBob = nextState(alice);
    // Lowercase + dash should be normalized.
    const joined = ok(
      await emitRaw<JoinedRoom>(bob, 'room:join', { code: `${code.slice(0, 2).toLowerCase()}-${code.slice(2)}`, nickname: 'Bob' }),
    );
    assert.equal(joined.room.players.length, 2);
    assert.equal((await aliceSeesBob).players.length, 2);

    const carol = await client();
    assert.equal(errorCode(await emitRaw(carol, 'room:join', { code, nickname: 'ALICE' })), 'NICKNAME_TAKEN');
    assert.equal(errorCode(await emitRaw(carol, 'room:join', { code: 'XXXXX', nickname: 'Carol' })), 'ROOM_NOT_FOUND');
    assert.equal(errorCode(await emitRaw(carol, 'room:join', { code: '0O1', nickname: 'Carol' })), 'INVALID_ROOM_CODE');
    assert.equal(errorCode(await emitRaw(carol, 'room:join', { code, nickname: 'x' })), 'INVALID_NICKNAME');
    assert.equal(errorCode(await emitRaw(carol, 'room:join', 'nonsense')), 'INVALID_PAYLOAD');
    assert.equal(errorCode(await emitRaw(carol, 'room:join', { code, nickname: 42 })), 'INVALID_PAYLOAD');
    ok(await emitRaw(carol, 'room:join', { code, nickname: 'Carol' }));

    assert.equal(errorCode(await emitRaw(carol, 'room:join', { code, nickname: 'Carol2' })), 'ALREADY_IN_ROOM');

    const dave = await client();
    assert.equal(errorCode(await emitRaw(dave, 'room:join', { code, nickname: 'Dave' })), 'ROOM_FULL');

    assert.equal(errorCode(await emitRaw(bob, 'game:start')), 'NOT_HOST');
    const started = nextState(bob);
    ok(await emitRaw(alice, 'game:start'));
    assert.equal((await started).phase, 'choosing');

    const afterLeave = nextState(bob);
    ok(await emitRaw(alice, 'room:leave'));
    const state = await afterLeave;
    assert.equal(state.players.length, 2);
    assert.equal(state.players.find((p) => p.isHost)?.nickname, 'Bob');
  });

  it('marks players disconnected and lets them rejoin with their session token', async () => {
    const host = await client();
    const created = ok(await emitRaw<JoinedRoom>(host, 'room:create', { nickname: 'Host' }));
    const guest = await client();
    const seat = ok(await emitRaw<JoinedRoom>(guest, 'room:join', { code: created.room.code, nickname: 'Guest' }));

    const sawDisconnect = nextState(host);
    guest.disconnect();
    assert.equal((await sawDisconnect).players.find((p) => p.id === seat.playerId)?.connected, false);

    const guestAgain = await client();
    const rejoined = ok(
      await emitRaw<JoinedRoom>(guestAgain, 'room:rejoin', { code: created.room.code, sessionToken: seat.sessionToken }),
    );
    assert.equal(rejoined.playerId, seat.playerId);
    assert.equal(rejoined.room.players.find((p) => p.id === seat.playerId)?.connected, true);

    // A second connection claiming the same seat replaces the first.
    const replaced = new Promise<void>((resolve) => guestAgain.once('session:replaced', () => resolve()));
    const thirdTab = await client();
    ok(await emitRaw(thirdTab, 'room:rejoin', { code: created.room.code, sessionToken: seat.sessionToken }));
    await replaced;

    assert.equal(
      errorCode(await emitRaw(thirdTab, 'room:rejoin', { code: created.room.code, sessionToken: 'not-a-real-token-123' })),
      'SESSION_EXPIRED',
    );
  });

  it('keeps the current seat when a rejoin attempt fails', async () => {
    const host = await client();
    const created = ok(await emitRaw<JoinedRoom>(host, 'room:create', { nickname: 'Stayer' }));
    const other = await client();
    const otherRoom = ok(await emitRaw<JoinedRoom>(other, 'room:create', { nickname: 'Other' }));

    const failed = await emitRaw(host, 'room:rejoin', { code: otherRoom.room.code, sessionToken: 'bogus-token-bogus-token' });
    assert.equal(errorCode(failed), 'SESSION_EXPIRED');
    const room = app.rooms.getRoom(created.room.code);
    assert.ok(room?.players.has(created.playerId), 'player must still be seated in their original room');
  });

  it('does not leave a ghost seat when a socket switches seats within a room', async () => {
    const host = await client();
    const created = ok(await emitRaw<JoinedRoom>(host, 'room:create', { nickname: 'Host2' }));
    const code = created.room.code;
    const a = await client();
    const seatA = ok(await emitRaw<JoinedRoom>(a, 'room:join', { code, nickname: 'SeatA' }));
    const b = await client();
    const seatB = ok(await emitRaw<JoinedRoom>(b, 'room:join', { code, nickname: 'SeatB' }));
    b.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // Socket `a` reclaims seat B; seat A must not stay "connected" to it forever.
    ok(await emitRaw(a, 'room:rejoin', { code, sessionToken: seatB.sessionToken }));
    const snapshot = app.rooms.toSnapshot(app.rooms.getRoom(code)!);
    const ghost = snapshot.players.find((p) => p.id === seatA.playerId);
    assert.ok(!ghost || !ghost.connected, 'previous seat must not remain attached to the socket');
  });

  it('accepts nicknames written with combining marks (e.g. Devanagari)', async () => {
    const c = await client();
    const created = ok(await emitRaw<JoinedRoom>(c, 'room:create', { nickname: 'सौगात' }));
    assert.equal(created.room.players[0]?.nickname, 'सौगात');
  });

  it('drops events that have no acknowledgement callback', async () => {
    const c = await client();
    const roomsBefore = app.rooms.roomCount;
    (c.emit as (...a: unknown[]) => void)('room:create', { nickname: 'NoAck' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.rooms.roomCount, roomsBefore);
    // The server must still be responsive afterwards.
    ok(await emitRaw(c, 'room:leave'));
  });
});
