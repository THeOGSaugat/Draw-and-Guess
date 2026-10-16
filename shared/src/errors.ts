export const ERROR_MESSAGES = {
  INVALID_PAYLOAD: 'That request was malformed.',
  INVALID_NICKNAME: 'Nicknames must be 2–16 letters, numbers or spaces.',
  INVALID_ROOM_CODE: "That doesn't look like a valid room code.",
  ROOM_NOT_FOUND: "We couldn't find a room with that code.",
  ROOM_FULL: 'That room is full.',
  NICKNAME_TAKEN: 'Someone in that room already has that nickname.',
  GAME_IN_PROGRESS: 'That game has already started.',
  NOT_IN_ROOM: "You're not in a room.",
  ALREADY_IN_ROOM: "You're already in this room.",
  NOT_HOST: 'Only the host can do that.',
  NOT_ENOUGH_PLAYERS: 'You need at least 2 connected players to start.',
  SESSION_EXPIRED: 'Your previous session has expired.',
  SERVER_FULL: 'The server is busy right now. Please try again shortly.',
  RATE_LIMITED: "Whoa, slow down! Try again in a moment.",
  INTERNAL: 'Something went wrong on our side.',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export interface GameError {
  code: ErrorCode;
  message: string;
}

export type AckResult<T> = { ok: true; data: T } | { ok: false; error: GameError };

export function gameError(code: ErrorCode, message: string = ERROR_MESSAGES[code]): GameError {
  return { code, message };
}
