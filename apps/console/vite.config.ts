import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const api = process.env.PE_API_URL ?? 'http://127.0.0.1:4200';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': api, '/healthz': api } },
  test: { environment: 'jsdom' },
});
