import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {defineConfig} from 'vite';
import packageJson from './package.json';

/**
 * The backend only answers requests that carry its per-start session token. In
 * production the token is injected into the HTML the backend itself serves; when the UI
 * runs on the Vite dev server we have to inject the same token here, reading it from the
 * file server.ts writes at startup (`AppData/Roaming/OctosArmy/config/session.token`).
 */
const SESSION_TOKEN_FILE = path.join(os.homedir(), 'AppData', 'Roaming', 'OctosArmy', 'config', 'session.token');

function octosSessionToken() {
  return {
    name: 'octos-session-token',
    transformIndexHtml(html: string) {
      let token = '';
      try {
        token = fs.readFileSync(SESSION_TOKEN_FILE, 'utf-8').trim();
      } catch {
        // Backend not started yet: the UI will show its usual "server not ready" notice.
      }
      if (!token) return html;
      const injection = `<script>window.__OCTOS_TOKEN__=${JSON.stringify(token)};</script>`;
      return html.includes('</head>') ? html.replace('</head>', `${injection}</head>`) : injection + html;
    },
  };
}

export default defineConfig(() => {
  return {
    base: './',
    plugins: [react(), tailwindcss(), octosSessionToken()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // If you run `vite` on :5173 and `tsx server.ts` on :3000, /api is proxied.
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
