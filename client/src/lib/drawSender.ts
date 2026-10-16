import { DRAW_LIMITS, type DrawOp } from '@draw-guess/shared';
import { packBatches } from './drawBatching';
import { socket } from './socket';

/** Batches the drawer's ops so pointer movement is sent ~25 times a second, not per event. */
const FLUSH_INTERVAL_MS = 40;

let roundId: number | null = null;
let queue: DrawOp[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function queueDrawOp(currentRoundId: number, op: DrawOp): void {
  if (roundId !== currentRoundId) {
    discardPendingDrawOps();
    roundId = currentRoundId;
  }
  const last = queue.at(-1);
  // Merge consecutive point runs for the same stroke to keep batches compact.
  if (op.t === 'points' && last?.t === 'points' && last.id === op.id && last.pts.length + op.pts.length <= DRAW_LIMITS.pointsPerOp * 2) {
    last.pts.push(...op.pts);
  } else {
    queue.push(op.t === 'points' ? { ...op, pts: [...op.pts] } : op);
  }
  timer ??= setTimeout(flushDrawOps, FLUSH_INTERVAL_MS);
}

/** Sends everything queued now (e.g. before clearing the canvas so order is kept). */
export function flushDrawOps(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (queue.length === 0 || roundId === null) return;
  const ops = queue;
  queue = [];
  // While offline, drop rather than buffer: the server restores the canonical drawing on rejoin.
  if (!socket.connected) return;
  for (const batch of packBatches(ops)) socket.emit('draw:ops', { roundId, ops: batch });
}

export function discardPendingDrawOps(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  queue = [];
}
