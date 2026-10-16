import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CANVAS_BACKGROUND, COORD_MAX, DRAW_LIMITS, type DrawOp, type DrawTool } from '@draw-guess/shared';
import { BoardRenderer } from '../lib/boardRenderer';
import { queueDrawOp } from '../lib/drawSender';
import { board } from '../lib/strokeBoard';

/** Upper bound on backing-store size; plenty for 3x screens without wasting memory. */
const MAX_PIXELS = 2048;

interface DrawingCanvasProps {
  roundId: number | null;
  /** True only for the drawer, while drawing and connected. */
  interactive: boolean;
  tool: DrawTool;
  color: string;
  size: number;
  /** Server hint for the next valid stroke id (drawer only). */
  nextStrokeId: number | null;
}

interface ActiveStroke {
  pointerId: number;
  id: number;
  points: number;
  lastX: number;
  lastY: number;
}

export function DrawingCanvas({ roundId, interactive, tool, color, size, nextStrokeId }: DrawingCanvasProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const activeRef = useRef<ActiveStroke | null>(null);
  const strokeCounter = useRef({ roundId: null as number | null, next: 1 });
  const [cssSize, setCssSize] = useState(0);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);

  useLayoutEffect(() => {
    const renderer = new BoardRenderer(board);
    renderer.attach(baseRef.current!, liveRef.current!);
    rendererRef.current = renderer;
    return () => {
      renderer.detach();
      rendererRef.current = null;
    };
  }, []);

  // Largest square that fits the available area; re-measured on resize/rotation/keyboard.
  useLayoutEffect(() => {
    const area = areaRef.current!;
    const measure = () => {
      const { width, height } = area.getBoundingClientRect();
      setCssSize(Math.max(0, Math.floor(Math.min(width, height))));
      setDpr(window.devicePixelRatio || 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    window.addEventListener('resize', measure); // also fires when DPR changes (zoom, moving screens)
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // DPR can change without any resize (e.g. dragging the window to another monitor);
  // a resolution media query for the current DPR fires when it stops matching.
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [dpr]);

  useLayoutEffect(() => {
    const pixels = Math.min(MAX_PIXELS, Math.round(cssSize * dpr));
    for (const canvas of [baseRef.current!, liveRef.current!]) {
      canvas.width = pixels;
      canvas.height = pixels;
    }
    rendererRef.current?.resize(pixels);
  }, [cssSize, dpr]);

  // Stop an in-progress stroke if drawing gets disabled (round ended, went offline).
  useEffect(() => {
    if (!interactive) finishStroke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  function send(op: DrawOp) {
    if (roundId === null) return;
    board.apply([op]);
    queueDrawOp(roundId, op);
  }

  function allocateStrokeId(): number {
    const counter = strokeCounter.current;
    if (counter.roundId !== roundId) {
      counter.roundId = roundId;
      counter.next = 1;
    }
    const id = Math.max(counter.next, board.maxStrokeId + 1, nextStrokeId ?? 1);
    counter.next = id + 1;
    return id;
  }

  function toCoords(clientX: number, clientY: number): [number, number] {
    const rect = liveRef.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [
      Math.round(clamp((clientX - rect.left) / rect.width) * COORD_MAX),
      Math.round(clamp((clientY - rect.top) / rect.height) * COORD_MAX),
    ];
  }

  function beginStroke(pointerId: number, x: number, y: number) {
    const id = allocateStrokeId();
    send({ t: 'begin', id, tool, color: tool === 'eraser' ? CANVAS_BACKGROUND : color, size, x, y });
    activeRef.current = { pointerId, id, points: 1, lastX: x, lastY: y };
  }

  function finishStroke() {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    send({ t: 'end', id: active.id });
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!interactive || activeRef.current || roundId === null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toCoords(e.clientX, e.clientY);
    beginStroke(e.pointerId, x, y);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const active = activeRef.current;
    if (!active || e.pointerId !== active.pointerId) return;
    e.preventDefault();
    // Coalesced events recover the intermediate samples browsers merge per frame → smoother lines.
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const events = samples.length > 0 ? samples : [e.nativeEvent];
    let pts: number[] = [];
    for (const ev of events) {
      const [x, y] = toCoords(ev.clientX, ev.clientY);
      if (x === active.lastX && y === active.lastY) continue;
      pts.push(x, y);
      active.lastX = x;
      active.lastY = y;
      active.points++;
      // The server caps points per stroke; continue seamlessly in a new stroke instead.
      if (active.points >= DRAW_LIMITS.pointsPerStroke) {
        send({ t: 'points', id: active.id, pts });
        pts = [];
        send({ t: 'end', id: active.id });
        beginStroke(active.pointerId, x, y);
        return;
      }
    }
    if (pts.length > 0) send({ t: 'points', id: active.id, pts });
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (activeRef.current?.pointerId === e.pointerId) finishStroke();
  }

  return (
    <div ref={areaRef} className="relative grid h-full min-h-0 w-full min-w-0 place-items-center">
      <div
        className="relative overflow-hidden rounded-2xl bg-white shadow-[0_10px_30px_-10px_rgb(0_0_0/0.6)] ring-1 ring-white/10"
        style={{ width: cssSize, height: cssSize }}
      >
        <canvas ref={baseRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
        <canvas
          ref={liveRef}
          role="img"
          aria-label={interactive ? 'Drawing canvas. Draw with your finger, stylus or mouse.' : 'The drawer’s canvas'}
          className={`absolute inset-0 h-full w-full touch-none select-none ${interactive ? 'cursor-crosshair' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
