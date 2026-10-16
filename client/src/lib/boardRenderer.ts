import { CANVAS_BACKGROUND, COORD_MAX, type Stroke } from '@draw-guess/shared';
import type { BoardChange, StrokeBoard } from './strokeBoard';

/** Draws one stroke with midpoint quadratic smoothing. `scale` maps coords to canvas pixels. */
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, scale: number): void {
  const p = stroke.pts;
  const n = p.length / 2;
  if (n === 0) return;
  const width = Math.max(1, stroke.size * scale);
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0]! * scale, p[1]! * scale, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(p[0]! * scale, p[1]! * scale);
  for (let i = 1; i < n - 1; i++) {
    const x = p[i * 2]! * scale;
    const y = p[i * 2 + 1]! * scale;
    const nx = p[(i + 1) * 2]! * scale;
    const ny = p[(i + 1) * 2 + 1]! * scale;
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  ctx.lineTo(p[(n - 1) * 2]! * scale, p[(n - 1) * 2 + 1]! * scale);
  ctx.stroke();
}

/**
 * Two stacked canvases: finished strokes are drawn once onto `base`; strokes
 * still in progress are redrawn on `live` each animation frame. Both share the
 * same drawing code, so a stroke looks identical before and after it finishes.
 */
export class BoardRenderer {
  private base: CanvasRenderingContext2D | null = null;
  private live: CanvasRenderingContext2D | null = null;
  private pixelSize = 0;
  /** Number of leading strokes already painted onto the base layer. */
  private committed = 0;
  private frame = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly board: StrokeBoard) {}

  attach(base: HTMLCanvasElement, live: HTMLCanvasElement): void {
    this.base = base.getContext('2d');
    this.live = live.getContext('2d');
    this.unsubscribe = this.board.subscribe((change: BoardChange) => {
      if (change === 'reset') this.committed = 0;
      this.schedule(change === 'reset');
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.base = this.live = null;
  }

  /** Call after changing the canvases' pixel size; repaints everything. */
  resize(pixelSize: number): void {
    this.pixelSize = pixelSize;
    this.committed = 0;
    this.schedule(true);
  }

  private needsFullRepaint = false;

  private schedule(full: boolean): void {
    this.needsFullRepaint ||= full;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    const { base, live } = this;
    if (!base || !live || this.pixelSize === 0) return;
    const scale = this.pixelSize / COORD_MAX;
    const strokes = this.board.strokes;

    if (this.needsFullRepaint) {
      this.needsFullRepaint = false;
      this.committed = 0;
      base.fillStyle = CANVAS_BACKGROUND;
      base.fillRect(0, 0, this.pixelSize, this.pixelSize);
    }
    while (this.committed < strokes.length && strokes[this.committed]!.done) {
      drawStroke(base, strokes[this.committed]!, scale);
      this.committed++;
    }
    live.clearRect(0, 0, this.pixelSize, this.pixelSize);
    for (let i = this.committed; i < strokes.length; i++) drawStroke(live, strokes[i]!, scale);
  }
}
