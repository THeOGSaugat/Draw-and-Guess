import { DRAW_LIMITS, type DrawOp } from '@draw-guess/shared';

/**
 * Points per emitted batch. Keeps every message far below the server's 100 KB
 * Socket.IO limit (exceeding it would disconnect the drawer).
 */
export const MAX_POINTS_PER_BATCH = 1024;

/** Splits queued ops into batches that respect the server's op, per-op point, and size limits. */
export function packBatches(ops: readonly DrawOp[]): DrawOp[][] {
  const batches: DrawOp[][] = [];
  let current: DrawOp[] = [];
  let points = 0;
  const flush = () => {
    if (current.length > 0) batches.push(current);
    current = [];
    points = 0;
  };
  for (const op of ops) {
    if (op.t !== 'points') {
      if (current.length >= DRAW_LIMITS.opsPerBatch) flush();
      current.push(op);
      continue;
    }
    // Long point runs are split into several ops/batches; order is preserved.
    for (let i = 0; i < op.pts.length; ) {
      if (current.length >= DRAW_LIMITS.opsPerBatch || points >= MAX_POINTS_PER_BATCH) flush();
      const room = Math.min(DRAW_LIMITS.pointsPerOp, MAX_POINTS_PER_BATCH - points);
      const chunk = op.pts.slice(i, i + room * 2);
      current.push({ t: 'points', id: op.id, pts: chunk });
      points += chunk.length / 2;
      i += chunk.length;
    }
  }
  flush();
  return batches;
}
