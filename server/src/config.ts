import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PLAYERS, MIN_PLAYERS } from '@draw-guess/shared';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

// Load the repo-root .env if present (Node >= 20.12). Real env vars win.
const envFile = resolve(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return Math.min(max, Math.max(min, value));
}

function listFromEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: intFromEnv('PORT', 3001, 1, 65535),
  host: process.env.HOST?.trim() || '0.0.0.0',
  /** Extra origins allowed to connect (only needed when the client is hosted elsewhere). */
  corsOrigins: listFromEnv('CORS_ORIGINS'),
  maxPlayersPerRoom: intFromEnv('MAX_PLAYERS_PER_ROOM', MAX_PLAYERS, MIN_PLAYERS, MAX_PLAYERS),
  maxRooms: intFromEnv('MAX_ROOMS', 500, 1, 100_000),
  /** How long a disconnected player keeps their seat before being removed. */
  reconnectGraceMs: intFromEnv('RECONNECT_GRACE_MS', 30_000, 0, 10 * 60_000),
  /** How long a disconnected host stays host before the role moves to a connected player. */
  hostHandoffMs: intFromEnv('HOST_HANDOFF_MS', 10_000, 0, 10 * 60_000),
  /** Built client served in production, if it exists. `--no-client` (used by `npm run dev`) disables it. */
  clientDistDir: process.argv.includes('--no-client')
    ? undefined
    : resolve(repoRoot, process.env.CLIENT_DIST_DIR?.trim() || 'client/dist'),
} as const;

export type Config = typeof config;
