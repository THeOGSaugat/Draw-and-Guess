import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DRAW_LIMITS, type DrawOp } from '@draw-guess/shared';
import { MAX_POINTS_PER_BATCH, packBatches } from '../src/lib/drawBatching.ts';
import { StrokeBoard } from '../src/lib/strokeBoard.ts';

const begin = (id: number): DrawOp => ({ t: 'begin', id, tool: 'pen', color: '#1f2333', size: 8, x: 10, y: 10 });

describe('StrokeBoard', () => {
  it('applies ops with the same rules as the server (same input → same strokes)', () => {
    // Mirrors server/test/round.test.ts "keeps stroke order and ignores out-of-order or mismatched ops",
    // using the ops the server accepted and relayed.
    const board = new StrokeBoard();
    board.reset(1);
    board.apply([begin(1), { t: 'points', id: 1, pts: [20, 20, 30, 30] }, { t: 'points', id: 9, pts: [1, 1] }, { t: 'end', id: 1 }]);
    board.apply([begin(2), { t: 'points', id: 2, pts: [5, 5] }]);
    assert.deepEqual(board.strokes.map((s) => [s.id, s.pts, s.done]), [
      [1, [10, 10, 20, 20, 30, 30], true],
      [2, [10, 10, 5, 5], false],
    ]);
  });

  it('a new stroke closes an unfinished one; reset/clear notify listeners', () => {
    const board = new StrokeBoard();
    const changes: string[] = [];
    board.subscribe((c) => changes.push(c));
    board.reset(3, [{ id: 4, tool: 'pen', color: '#1f2333', size: 8, pts: [1, 1], done: false }]);
    board.apply([begin(5)]);
    assert.deepEqual(board.strokes.map((s) => s.done), [true, false]);
    assert.equal(board.maxStrokeId, 5);
    board.clear();
    assert.deepEqual(board.strokes, []);
    assert.equal(board.roundId, 3);
    assert.deepEqual(changes, ['reset', 'update', 'reset']);
  });
});

describe('packBatches', () => {
  it('keeps order and respects op, per-op point, and per-batch point limits', () => {
    const longRun = Array.from({ length: 3000 * 2 }, (_, i) => i % 2000);
    const ops: DrawOp[] = [begin(1), { t: 'points', id: 1, pts: longRun }, { t: 'end', id: 1 }];
    for (let i = 2; i < 150; i++) ops.push(begin(i), { t: 'end', id: i });
    const batches = packBatches(ops);

    const flat = batches.flat();
    const pts = flat.flatMap((op) => (op.t === 'points' ? op.pts : []));
    assert.deepEqual(pts, longRun, 'points survive splitting in order');
    assert.deepEqual(
      flat.filter((op) => op.t !== 'points'),
      ops.filter((op) => op.t !== 'points'),
      'non-point ops keep their order',
    );
    for (const batch of batches) {
      assert.ok(batch.length > 0 && batch.length <= DRAW_LIMITS.opsPerBatch);
      const n = batch.reduce((sum, op) => sum + (op.t === 'points' ? op.pts.length / 2 : 0), 0);
      assert.ok(n <= MAX_POINTS_PER_BATCH);
      for (const op of batch) if (op.t === 'points') assert.ok(op.pts.length <= DRAW_LIMITS.pointsPerOp * 2);
      // Worst case stays well under the server's 100 KB message limit.
      assert.ok(JSON.stringify({ roundId: 1, ops: batch }).length < 50_000);
    }
  });

  it('returns nothing for an empty queue', () => {
    assert.deepEqual(packBatches([]), []);
  });
});
