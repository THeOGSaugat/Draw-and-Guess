export interface DrawerCandidate {
  id: string;
  /** Join order; lower joined earlier. */
  joinSeq: number;
  draws: number;
}

/**
 * Fair drawer choice among eligible (connected) players:
 *  1. never the previous drawer while anyone else is eligible,
 *  2. fewest draws so far this match,
 *  3. ties → the next player in join order after the previous drawer (wrapping).
 */
export function pickDrawer<T extends DrawerCandidate>(
  eligible: readonly T[],
  lastDrawerId: string | null,
  lastDrawerSeq: number,
): T {
  if (eligible.length === 0) throw new Error('pickDrawer needs at least one candidate');
  const ordered = [...eligible].sort((a, b) => a.joinSeq - b.joinSeq);
  let pool = ordered.length > 1 ? ordered.filter((p) => p.id !== lastDrawerId) : ordered;
  const fewest = Math.min(...pool.map((p) => p.draws));
  pool = pool.filter((p) => p.draws === fewest);
  return pool.find((p) => p.joinSeq > lastDrawerSeq) ?? pool[0]!;
}
