import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const api = process.env.PE_API_URL ?? 'http://127.0.0.1:4200';

export default defineConfig({
  plugins: [react()],
  // Tooling at the repo root (@asyncapi) hoists React 17; always resolve the console's React 19 so libraries such
  // as lucide-react and @xyflow/react share one copy.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 5173, proxy: { '/api': api, '/healthz': api, '/a/': api } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
