import { ERROR_MESSAGES, type ErrorCode } from '@draw-guess/shared';

/** Expected, user-facing failure. Anything else thrown is treated as INTERNAL. */
export class RoomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = 'RoomError';
  }
}
