import {
  BRUSH_COLORS,
  BRUSH_SIZES,
  CANVAS_BACKGROUND,
  COORD_MAX,
  DRAW_LIMITS,
  type DrawOp,
  type DrawOpsPayload,
  type Stroke,
} from '@draw-guess/shared';
import { RoomError } from '../rooms/RoomError.js';

const COLORS = new Set<string>(BRUSH_COLORS.map((c) => c.value));
const SIZES = new Set<number>(BRUSH_SIZES.map((s) => s.value));

const isCoord = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= COORD_MAX;
const isStrokeId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 1e9;

function parseOp(raw: unknown): DrawOp {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RoomError('INVALID_PAYLOAD');
  const op = raw as Record<string, unknown>;
  if (!isStrokeId(op.id)) throw new RoomError('INVALID_PAYLOAD');
  switch (op.t) {
    case 'begin': {
      const tool = op.tool;
      if (tool !== 'pen' && tool !== 'eraser') throw new RoomError('INVALID_PAYLOAD');
      if (!SIZES.has(op.size as number) || !isCoord(op.x) || !isCoord(op.y)) throw new RoomError('INVALID_PAYLOAD');
      if (tool === 'pen' && !COLORS.has(op.color as string)) throw new RoomError('INVALID_PAYLOAD');
      // Rebuild the object so no unexpected fields are ever relayed to other players.
      return {
        t: 'begin',
        id: op.id,
        tool,
        color: tool === 'eraser' ? CANVAS_BACKGROUND : (op.color as string),
        size: op.size as number,
        x: op.x,
        y: op.y,
      };
    }
    case 'points': {
      const pts = op.pts;
      if (!Array.isArray(pts) || pts.length === 0 || pts.length % 2 !== 0 || pts.length > DRAW_LIMITS.pointsPerOp * 2) {
        throw new RoomError('INVALID_PAYLOAD');
      }
      if (!pts.every(isCoord)) throw new RoomError('INVALID_PAYLOAD');
      return { t: 'points', id: op.id, pts: [...pts] };
    }
    case 'end':
      return { t: 'end', id: op.id };
    default:
      throw new RoomError('INVALID_PAYLOAD');
  }
}

/** Validates the shape of a draw:ops payload. Any invalid op rejects the whole batch. */
export function parseDrawOps(payload: unknown): DrawOpsPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new RoomError('INVALID_PAYLOAD');
  const body = payload as Record<string, unknown>;
  if (!Number.isInteger(body.roundId) || !Array.isArray(body.ops)) throw new RoomError('INVALID_PAYLOAD');
  if (body.ops.length === 0 || body.ops.length > DRAW_LIMITS.opsPerBatch) throw new RoomError('INVALID_PAYLOAD');
  return { roundId: body.roundId as number, ops: body.ops.map(parseOp) };
}

export interface StrokeStore {
  strokes: Stroke[];
  pointCount: number;
  lastStrokeId: number;
}

export function emptyStrokeStore(): StrokeStore {
  return { strokes: [], pointCount: 0, lastStrokeId: 0 };
}

/**
 * Applies validated ops in order and returns the ones that were accepted, which
 * are what gets relayed. Ops that break ordering or exceed limits are dropped.
 */
export function applyDrawOps(store: StrokeStore, ops: DrawOp[]): DrawOp[] {
  const accepted: DrawOp[] = [];
  for (const op of ops) {
    const open = store.strokes.at(-1);
    const openStroke = open && !open.done ? open : null;

    if (op.t === 'begin') {
      // Stroke ids must strictly increase within a round, which keeps ordering unambiguous.
      if (op.id <= store.lastStrokeId) continue;
      if (store.strokes.length >= DRAW_LIMITS.strokesPerRound || store.pointCount >= DRAW_LIMITS.pointsPerRound) continue;
      if (openStroke) openStroke.done = true;
      store.strokes.push({ id: op.id, tool: op.tool, color: op.color, size: op.size, pts: [op.x, op.y], done: false });
      store.lastStrokeId = op.id;
      store.pointCount += 1;
      accepted.push(op);
    } else if (op.t === 'points') {
      if (!openStroke || openStroke.id !== op.id) continue;
      const room = Math.min(
        DRAW_LIMITS.pointsPerStroke - openStroke.pts.length / 2,
        DRAW_LIMITS.pointsPerRound - store.pointCount,
      );
      if (room <= 0) continue;
      const pts = op.pts.length / 2 > room ? op.pts.slice(0, room * 2) : op.pts;
      openStroke.pts.push(...pts);
      store.pointCount += pts.length / 2;
      accepted.push(pts === op.pts ? op : { t: 'points', id: op.id, pts });
    } else {
      if (!openStroke || openStroke.id !== op.id) continue;
      openStroke.done = true;
      accepted.push(op);
    }
  }
  return accepted;
}

/** Deep copy for sending to a (re)joining player. */
export function cloneStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.map((s) => ({ ...s, pts: [...s.pts] }));
}
