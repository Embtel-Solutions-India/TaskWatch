import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs separately (`npm run dev:server`, port API_PORT or 4000). Proxying /api keeps
// requests same-origin, so the session cookie and the CSRF header work without enabling CORS (SEC-4).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 4000}` },
  },
});
