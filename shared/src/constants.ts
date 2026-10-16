/** Hard limits for a room. The server may be configured lower, never higher. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/** Unambiguous characters only (no 0/O, 1/I/L) so codes are easy to read aloud. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 16;

/** Query-string key used in shareable invite links, e.g. https://host/?room=K7QXP */
export const INVITE_QUERY_PARAM = 'room';

/** Player accent colors, assigned in order of the first free slot. */
export const PLAYER_COLORS = [
  '#FF5D8F', // pink
  '#4CC9F0', // sky
  '#FFD23F', // sun
  '#7BE495', // mint
  '#B388FF', // lavender
  '#FF9F43', // tangerine
  '#3DDCBE', // teal
  '#F15BB5', // magenta
] as const;
