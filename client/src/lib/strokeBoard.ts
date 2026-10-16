import type { DrawOp, Stroke } from '@draw-guess/shared';

export type BoardChange = 'reset' | 'update';

/**
 * The current round's strokes, shared by the local drawer and remote viewers.
 * Applies ops with the same rules as the server, so everyone ends up with the
 * same strokes in the same order.
 */
export class StrokeBoard {
  roundId: number | null = null;
  strokes: Stroke[] = [];
  private readonly listeners = new Set<(change: BoardChange) => void>();

  subscribe(listener: (change: BoardChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(roundId: number | null, strokes: Stroke[] = []): void {
    this.roundId = roundId;
    this.strokes = strokes.map((s) => ({ ...s, pts: [...s.pts] }));
    this.emit('reset');
  }

  clear(): void {
    this.strokes = [];
    this.emit('reset');
  }

  get maxStrokeId(): number {
    return this.strokes.reduce((max, s) => Math.max(max, s.id), 0);
  }

  apply(ops: readonly DrawOp[]): void {
    let changed = false;
    for (const op of ops) {
      const last = this.strokes.at(-1);
      const open = last && !last.done ? last : null;
      if (op.t === 'begin') {
        if (open) open.done = true;
        this.strokes.push({ id: op.id, tool: op.tool, color: op.color, size: op.size, pts: [op.x, op.y], done: false });
        changed = true;
      } else if (open && open.id === op.id) {
        if (op.t === 'points') open.pts.push(...op.pts);
        else open.done = true;
        changed = true;
      }
    }
    if (changed) this.emit('update');
  }

  private emit(change: BoardChange): void {
    this.listeners.forEach((l) => l(change));
  }
}

/** The single board for this tab. */
export const board = new StrokeBoard();
