import { INVITE_QUERY_PARAM, ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@draw-guess/shared';

/** Seat credentials. sessionStorage is per-tab, so two tabs can be two players. */
export interface SavedSession {
  code: string;
  playerId: string;
  sessionToken: string;
}

const SESSION_KEY = 'dg:session';
const NICKNAME_KEY = 'dg:nickname';

function read(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function write(store: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). Not fatal.
  }
}

export function loadSession(): SavedSession | null {
  const raw = read(() => sessionStorage, SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedSession>;
    if (typeof parsed.code === 'string' && typeof parsed.playerId === 'string' && typeof parsed.sessionToken === 'string') {
      return parsed as SavedSession;
    }
  } catch {
    // fall through
  }
  write(() => sessionStorage, SESSION_KEY, null);
  return null;
}

export function saveSession(session: SavedSession | null): void {
  write(() => sessionStorage, SESSION_KEY, session && JSON.stringify(session));
}

export function loadNickname(): string {
  return read(() => localStorage, NICKNAME_KEY) ?? '';
}

export function saveNickname(nickname: string): void {
  write(() => localStorage, NICKNAME_KEY, nickname);
}

/** Room code from the current URL's invite parameter, if valid. */
export function readInviteCode(): string | null {
  const raw = new URLSearchParams(window.location.search).get(INVITE_QUERY_PARAM);
  if (!raw) return null;
  const code = normalizeRoomCode(raw);
  return isValidRoomCode(code) ? code : null;
}

/** Cleans room-code input; accepts a pasted invite link as well as a bare code. */
export function extractRoomCode(input: string): string {
  let raw = input;
  const fromLink = input.match(new RegExp(`[?&]${INVITE_QUERY_PARAM}=([^&#\\s]+)`, 'i'));
  if (fromLink?.[1]) {
    try {
      raw = decodeURIComponent(fromLink[1]);
    } catch {
      raw = fromLink[1];
    }
  }
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

export function buildInviteUrl(code: string): string {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set(INVITE_QUERY_PARAM, code);
  return url.toString();
}

/** Keeps the address bar in sync so reloading or copying the URL works. */
export function setUrlRoomCode(code: string | null): void {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set(INVITE_QUERY_PARAM, code);
  else url.searchParams.delete(INVITE_QUERY_PARAM);
  window.history.replaceState(null, '', url);
}
