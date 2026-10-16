import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Read the single repo-root .env shared with the server.
const envDir = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '');
  const apiTarget = `http://localhost:${env.PORT || '3001'}`;

  return {
    envDir,
    plugins: [react(), tailwindcss()],
    server: {
      host: env.DEV_HOST || 'localhost',
      port: Number(env.CLIENT_PORT || 5173),
      strictPort: true,
      // Proxy API + websocket traffic so the browser only ever talks to one origin.
      proxy: {
        '/api': apiTarget,
        '/socket.io': { target: apiTarget, ws: true },
      },
    },
  };
});
