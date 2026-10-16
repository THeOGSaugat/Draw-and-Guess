import {
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from './constants.js';

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
// Letters (any script, including combining marks such as Devanagari vowel
// signs), digits, spaces and a little punctuation.
const NICKNAME_PATTERN = /^[\p{L}\p{M}\p{N} _.'-]+$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Uppercases and strips whitespace/dashes so "k7q-xp" becomes "K7QXP". */
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_PATTERN.test(code);
}

/** Trims and collapses internal whitespace. */
export function normalizeNickname(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Returns an error string for display, or null if the (normalized) nickname is valid. */
export function nicknameProblem(nickname: string): string | null {
  const length = [...nickname].length;
  if (length < NICKNAME_MIN_LENGTH) return `Nickname must be at least ${NICKNAME_MIN_LENGTH} characters.`;
  if (length > NICKNAME_MAX_LENGTH) return `Nickname must be at most ${NICKNAME_MAX_LENGTH} characters.`;
  if (!NICKNAME_PATTERN.test(nickname)) return 'Use letters, numbers, spaces, or . _ \' -';
  if (!HAS_LETTER_OR_DIGIT.test(nickname)) return 'Nickname needs at least one letter or number.';
  return null;
}

/** Comparison key for duplicate-nickname checks. */
export function nicknameKey(nickname: string): string {
  return normalizeNickname(nickname).toLocaleLowerCase('en');
}
