import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@draw-guess/shared';

export function generateRoomCode(isTaken: (code: string) => boolean): string {
  // ~28M possible codes, so collisions are rare; bail out rather than spin forever.
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (!isTaken(code)) return code;
  }
  throw new Error('Unable to generate a unique room code');
}
