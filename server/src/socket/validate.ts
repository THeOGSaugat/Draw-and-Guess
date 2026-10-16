import {
  isValidRoomCode,
  nicknameProblem,
  normalizeNickname,
  normalizeRoomCode,
} from '@draw-guess/shared';
import { RoomError } from '../rooms/RoomError.js';

/** Generous cap applied before any normalization/regex work. */
const MAX_RAW_STRING = 64;

export function asObject(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new RoomError('INVALID_PAYLOAD');
  }
  return payload as Record<string, unknown>;
}

function rawString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length > MAX_RAW_STRING) {
    throw new RoomError('INVALID_PAYLOAD');
  }
  return value;
}

export function readNickname(obj: Record<string, unknown>): string {
  const nickname = normalizeNickname(rawString(obj, 'nickname'));
  const problem = nicknameProblem(nickname);
  if (problem) throw new RoomError('INVALID_NICKNAME', problem);
  return nickname;
}

export function readRoomCode(obj: Record<string, unknown>): string {
  const code = normalizeRoomCode(rawString(obj, 'code'));
  if (!isValidRoomCode(code)) throw new RoomError('INVALID_ROOM_CODE');
  return code;
}

export function readSessionToken(obj: Record<string, unknown>): string {
  const token = rawString(obj, 'sessionToken');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new RoomError('SESSION_EXPIRED');
  return token;
}
