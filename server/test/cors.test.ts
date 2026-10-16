import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { createApp, type AppInstance } from '../src/createApp.js';

const apps: AppInstance[] = [];
after(async () => {
  for (const app of apps) {
    app.rooms.dispose();
    await app.io.close();
  }
});

async function start(corsOrigins: string[]) {
  const app = createApp({
    corsOrigins,
    maxPlayersPerRoom: 8,
    maxRooms: 5,
    reconnectGraceMs: 1000,
    hostHandoffMs: 1000,
    wordChoiceMs: 1000,
    drawTimeMs: 1000,
    roundResultsMs: 1000,
  });
  apps.push(app);
  await new Promise<void>((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(app.httpServer.address() as AddressInfo).port}`;
}

/** The Socket.IO handshake a browser on `origin` would make. */
const handshake = (url: string, origin: string) =>
  fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } });

describe('CORS for a separately hosted frontend', () => {
  it('same-origin setup (no CORS_ORIGINS) sends no cross-origin permission', async () => {
    const url = await start([]);
    const res = await handshake(url, 'https://evil.example');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('allows exactly the configured origins and no others', async () => {
    const url = await start(['https://game.example.com', 'https://staging.example.com']);
    const allowed = await handshake(url, 'https://game.example.com');
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://game.example.com');
    const other = await handshake(url, 'https://staging.example.com');
    assert.equal(other.headers.get('access-control-allow-origin'), 'https://staging.example.com');
    for (const bad of ['https://evil.example', 'http://game.example.com', 'https://game.example.com.evil.example', 'https://sub.game.example.com']) {
      const res = await handshake(url, bad);
      assert.equal(res.headers.get('access-control-allow-origin'), null, `${bad} must not be allowed`);
    }
  });

  it('answers the browser preflight for an allowed origin', async () => {
    const url = await start(['https://game.example.com']);
    const res = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://game.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    assert.ok(res.status === 204 || res.status === 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://game.example.com');
  });

  it('health endpoint is reachable without CORS configuration', async () => {
    const url = await start([]);
    const body = (await (await fetch(`${url}/api/health`)).json()) as { status: string };
    assert.equal(body.status, 'ok');
  });
});
