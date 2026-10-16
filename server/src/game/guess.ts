/** Normalization used to compare guesses: case, spacing and hyphens don't matter. */
export function normalizeGuess(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en').replace(/[-_]/g, ' ').trim().replace(/\s+/g, ' ');
}

export function isCorrectGuess(guess: string, word: string): boolean {
  return normalizeGuess(guess) === normalizeGuess(word);
}

const lettersOnly = (text: string) => normalizeGuess(text).replace(/[^\p{L}\p{N}]/gu, '');

/**
 * True when a message contains the word anywhere, even inside other words or
 * with spaces removed ("maybe zebracorns?"). Used to keep such messages away
 * from players who haven't guessed yet. Errs on the side of hiding.
 */
export function mentionsWord(text: string, word: string): boolean {
  const target = lettersOnly(word);
  return target.length > 0 && lettersOnly(text).includes(target);
}

/** Public hint: one underscore per letter, separators kept ("ice cream" → "___ _____"). */
export function maskWord(word: string): string {
  return word.replace(/[^\s-]/g, '_');
}

// Control characters plus zero-width / bidi-override characters that could disguise text.
const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** Strips control characters and collapses whitespace in chat text. */
export function cleanChatText(text: string): string {
  return text.normalize('NFC').replace(INVISIBLE_OR_CONTROL, '').trim().replace(/\s+/g, ' ');
}
