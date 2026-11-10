import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The HOT wallet SDK reads Node's `global` and `Buffer` at import time.
  define: { global: 'globalThis' },
  resolve: { alias: { buffer: 'buffer/' } },
  server: { port: 3001 },
});
