import { useSyncExternalStore } from 'react';
import type {
  Ack,
  AckResult,
  ChatMessage,
  ChatResult,
  ErrorCode,
  JoinedRoom,
  PrivateRoundInfo,
  RoomSnapshot,
} from '@draw-guess/shared';
import { discardPendingDrawOps, flushDrawOps } from './drawSender';
import { socket } from './socket';
import { board } from './strokeBoard';
import { loadSession, saveSession, setUrlRoomCode } from './storage';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface Notice {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

export interface GameState {
  connection: ConnectionStatus;
  room: RoomSnapshot | null;
  playerId: string | null;
  /** True while trying to reclaim a seat saved in this tab. */
  restoring: boolean;
  notice: Notice | null;
  /** Latest private info; only meaningful when its roundId matches room.round.id. */
  privateRound: PrivateRoundInfo | null;
  chat: ChatMessage[];
  /** Local clock time (ms) when the current round phase ends, derived from remainingMs. */
  phaseDeadline: number | null;
  /** Local clock time (ms) when round results give way to the next round / final results. */
  advanceDeadline: number | null;
}

const CHAT_LIMIT = 100;

export type ClientErrorCode = ErrorCode | 'OFFLINE' | 'TIMEOUT';
export interface ClientError {
  code: ClientErrorCode;
  message: string;
}
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ClientError };

const ACK_TIMEOUT_MS = 8000;

let state: GameState = {
  connection: 'connecting',
  room: null,
  playerId: null,
  restoring: loadSession() !== null,
  notice: null,
  privateRound: null,
  chat: [],
  phaseDeadline: null,
  advanceDeadline: null,
};
const listeners = new Set<() => void>();
let noticeId = 0;

function setState(patch: Partial<GameState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGame(): GameState {
  return useSyncExternalStore(subscribe, () => state);
}

export function notify(kind: Notice['kind'], text: string): void {
  setState({ notice: { id: ++noticeId, kind, text } });
}

export function dismissNotice(id: number): void {
  if (state.notice?.id === id) setState({ notice: null });
}

/**
 * Sends a request and resolves with the server's acknowledgement. If the ack
 * arrives after the timeout, it is passed to `onLate` instead, so a request the
 * server did apply is never silently dropped.
 */
function request<T>(send: (ack: Ack<T>) => void, onLate?: (result: AckResult<T>) => void): Promise<ActionResult<T>> {
  if (!socket.connected) {
    return Promise.resolve({
      ok: false,
      error: { code: 'OFFLINE', message: "You're offline. Waiting for the connection to come back…" },
    });
  }
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ ok: false, error: { code: 'TIMEOUT', message: 'The server took too long to respond. Try again.' } });
    }, ACK_TIMEOUT_MS);
    send((result) => {
      if (timedOut) {
        onLate?.(result);
        return;
      }
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/** Applies a room snapshot, resetting the canvas when a new round begins. */
function applyRoom(room: RoomSnapshot): Partial<GameState> {
  const roundId = room.round?.id ?? null;
  if (board.roundId !== roundId) {
    discardPendingDrawOps();
    board.reset(roundId);
  }
  const remaining = room.round?.remainingMs;
  const advanceIn = room.match?.nextInMs;
  return {
    room,
    phaseDeadline: remaining == null ? null : Date.now() + remaining,
    advanceDeadline: advanceIn == null ? null : Date.now() + advanceIn,
  };
}

function enterRoom({ room, playerId, sessionToken, game }: JoinedRoom): void {
  saveSession({ code: room.code, playerId, sessionToken });
  setUrlRoomCode(room.code);
  const patch = applyRoom(room);
  // Catch up with a round in progress: canonical strokes, private info, and chat.
  board.reset(room.round?.id ?? null, game?.strokes ?? []);
  setState({
    ...patch,
    playerId,
    restoring: false,
    privateRound: game?.privateRound ?? null,
    chat: game ? game.chat : state.chat,
  });
}

/** Leaves the room locally. `keepCode` leaves the code in the URL so the home screen pre-fills it. */
function exitRoom(keepCode: string | null = null): void {
  saveSession(null);
  setUrlRoomCode(keepCode);
  discardPendingDrawOps();
  board.reset(null);
  setState({
    room: null,
    playerId: null,
    restoring: false,
    privateRound: null,
    chat: [],
    phaseDeadline: null,
    advanceDeadline: null,
  });
}

/** A create/join the server applied after we had already reported a timeout. */
function applyLateJoin(result: AckResult<JoinedRoom>): void {
  if (result.ok && state.room === null) {
    enterRoom(result.data);
    notify('info', `Sorry for the wait. You're in room ${result.data.room.code}.`);
  }
}

// Duplicated browser tabs inherit a copy of sessionStorage, and with it this
// tab's seat. Tabs answer a probe on this channel so a duplicate can tell the
// seat is already in use and start fresh instead of taking it over.
type TabMessage = { type: 'probe' | 'in-use'; token: string };
const tabChannel: BroadcastChannel | null = (() => {
  try {
    return new BroadcastChannel('dg:tabs');
  } catch {
    return null;
  }
})();

tabChannel?.addEventListener('message', (event: MessageEvent<TabMessage>) => {
  const msg = event.data;
  if (msg?.type === 'probe' && state.room && loadSession()?.sessionToken === msg.token) {
    tabChannel.postMessage({ type: 'in-use', token: msg.token } satisfies TabMessage);
  }
});

function isSeatOpenInAnotherTab(token: string): Promise<boolean> {
  const channel = tabChannel;
  if (!channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent<TabMessage>) => {
      if (event.data?.type === 'in-use' && event.data.token === token) finish(true);
    };
    const timer = setTimeout(() => finish(false), 200);
    function finish(inUse: boolean) {
      clearTimeout(timer);
      channel!.removeEventListener('message', onMessage);
      resolve(inUse);
    }
    channel.addEventListener('message', onMessage);
    channel.postMessage({ type: 'probe', token } satisfies TabMessage);
  });
}

async function restoreSession(): Promise<void> {
  const saved = loadSession();
  if (!saved) {
    setState({ restoring: false });
    return;
  }
  setState({ restoring: true });
  const result = await request<JoinedRoom>((ack) =>
    socket.emit('room:rejoin', { code: saved.code, sessionToken: saved.sessionToken }, ack),
  );
  if (result.ok) {
    enterRoom(result.data);
    return;
  }
  if (result.error.code === 'OFFLINE' || result.error.code === 'TIMEOUT') {
    // Keep the saved seat; we'll try again on the next successful connect.
    setState({ restoring: false });
    return;
  }
  exitRoom(saved.code);
  notify(
    'error',
    result.error.code === 'SESSION_EXPIRED'
      ? `Your seat in room ${saved.code} expired. Join again to keep playing.`
      : result.error.message,
  );
}

let started = false;

/** Wires socket events into the store and opens the connection. Call once. */
export async function startGameClient(): Promise<void> {
  if (started) return;
  started = true;

  const saved = loadSession();
  if (saved && (await isSeatOpenInAnotherTab(saved.sessionToken))) {
    exitRoom(saved.code);
    notify('info', `Room ${saved.code} is already open in another tab. Pick a different nickname to join as a new player.`);
  }

  socket.on('connect', () => {
    setState({ connection: 'connected' });
    // Every new connection is a new server-side socket, so reclaim our seat.
    void restoreSession();
  });

  socket.on('disconnect', (reason) => {
    setState({ connection: 'reconnecting' });
    // A server-initiated disconnect does not auto-reconnect.
    if (reason === 'io server disconnect') socket.connect();
  });

  socket.on('connect_error', () => {
    setState({ connection: 'reconnecting' });
  });

  socket.on('room:state', (room) => {
    if (state.room?.code === room.code) setState(applyRoom(room));
  });

  socket.on('round:private', (info) => {
    if (state.room) setState({ privateRound: info });
  });

  socket.on('chat:message', (message) => {
    if (!state.room) return;
    setState({ chat: [...state.chat, message].slice(-CHAT_LIMIT) });
  });

  socket.on('draw:ops', ({ roundId, ops }) => {
    if (state.room && board.roundId === roundId) board.apply(ops);
  });

  socket.on('draw:clear', ({ roundId }) => {
    if (state.room && board.roundId === roundId) board.clear();
  });

  socket.on('session:replaced', () => {
    exitRoom(state.room?.code ?? null);
    notify('info', 'You opened this seat in another tab, so this tab left the room.');
  });

  socket.connect();
}

export function createRoom(nickname: string): Promise<ActionResult<JoinedRoom>> {
  return request<JoinedRoom>((ack) => socket.emit('room:create', { nickname }, ack), applyLateJoin).then((result) => {
    if (result.ok) enterRoom(result.data);
    return result;
  });
}

export function joinRoom(code: string, nickname: string): Promise<ActionResult<JoinedRoom>> {
  return request<JoinedRoom>((ack) => socket.emit('room:join', { code, nickname }, ack), applyLateJoin).then((result) => {
    if (result.ok) enterRoom(result.data);
    return result;
  });
}

/** Gives up on a saved seat we can't currently reach (e.g. server down). */
export function abandonSavedSession(): void {
  exitRoom();
}

export async function leaveRoom(): Promise<void> {
  // Leave locally no matter what; if offline, the server frees the seat after its grace period.
  await request<null>((ack) => socket.emit('room:leave', ack));
  exitRoom();
}

export function startGame(): Promise<ActionResult<null>> {
  return request<null>((ack) => socket.emit('game:start', ack));
}

export function returnToLobby(): Promise<ActionResult<null>> {
  return request<null>((ack) => socket.emit('game:returnToLobby', ack));
}

/**
 * Host skips the results countdown. If the countdown already moved the match on,
 * the server answers INVALID_PHASE; that's the desired outcome, so it counts as success.
 */
export async function nextRound(): Promise<ActionResult<null>> {
  const result = await request<null>((ack) => socket.emit('round:next', ack));
  return !result.ok && result.error.code === 'INVALID_PHASE' ? { ok: true, data: null } : result;
}

export async function playAgain(): Promise<ActionResult<null>> {
  const result = await request<null>((ack) => socket.emit('match:playAgain', ack));
  return !result.ok && result.error.code === 'INVALID_PHASE' ? { ok: true, data: null } : result;
}

export function chooseWord(index: number): Promise<ActionResult<null>> {
  return request<null>((ack) => socket.emit('round:chooseWord', { index }, ack));
}

export function sendChat(text: string): Promise<ActionResult<ChatResult>> {
  return request<ChatResult>((ack) => socket.emit('chat:send', { text }, ack));
}

/** Clears locally right away, after sending any queued strokes so the server sees the same order. */
export function clearCanvas(): Promise<ActionResult<null>> {
  const roundId = board.roundId;
  if (roundId === null) return Promise.resolve({ ok: true, data: null });
  flushDrawOps();
  board.clear();
  return request<null>((ack) => socket.emit('draw:clear', { roundId }, ack));
}

/** Private info for the current round, if any. */
export function currentPrivateRound(s: GameState): PrivateRoundInfo | null {
  return s.privateRound && s.room?.round && s.privateRound.roundId === s.room.round.id ? s.privateRound : null;
}
