import { SCORING } from '@draw-guess/shared';

/**
 * Points for a correct guess. `order` is 1 for the first correct guesser.
 * Earlier guessers get a higher base; everyone gets a speed bonus for time left.
 */
export function guessPoints(order: number, remainingMs: number, durationMs: number): number {
  const base = Math.max(SCORING.guessBaseMin, SCORING.guessBaseFirst - SCORING.guessBaseStep * (order - 1));
  const fraction = durationMs > 0 ? Math.min(1, Math.max(0, remainingMs / durationMs)) : 0;
  return base + Math.round(SCORING.speedBonusMax * fraction);
}

export const DRAWER_POINTS_PER_GUESS = SCORING.drawerPerGuess;

/**
 * Standard competition ranking ("1, 1, 3"): equal scores share a rank.
 * Input order is the tie-break for display (pass players in join order).
 */
export function rankByScore<T extends { score: number }>(entries: readonly T[]): (T & { rank: number })[] {
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index)
    .map(({ entry }) => entry);
  return sorted.map((entry, i) => {
    let rank = i + 1;
    if (i > 0 && sorted[i - 1]!.score === entry.score) {
      // Same score as the previous row → same rank as that row.
      let j = i - 1;
      while (j > 0 && sorted[j - 1]!.score === entry.score) j--;
      rank = j + 1;
    }
    return { ...entry, rank };
  });
}

/** Winners are all rank-1 players, but only if someone actually scored. */
export function winnersOf<T extends { score: number; rank: number; playerId: string }>(ranked: readonly T[]): string[] {
  if (ranked.length === 0 || ranked[0]!.score <= 0) return [];
  return ranked.filter((r) => r.rank === 1).map((r) => r.playerId);
}
