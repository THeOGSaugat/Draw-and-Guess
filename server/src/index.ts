import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { createApp } from './createApp.js';

const { httpServer, io, rooms } = createApp(config);

httpServer.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port}`);
  console.log(`[server] health check: http://localhost:${config.port}/api/health`);
  if (config.clientDistDir && existsSync(join(config.clientDistDir, 'index.html'))) {
    console.log(`[server] serving client from ${config.clientDistDir}`);
  }
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  rooms.dispose();
  void io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
