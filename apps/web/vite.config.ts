import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use the DSL package's TypeScript source directly (no build step for the UI).
    alias: {
      '@demo/dsl': fileURLToPath(new URL('../../packages/dsl/src/index.ts', import.meta.url)),
      // The worker owns the agent's context (system prompt, tools); the builder previews it.
      '@agent-context': fileURLToPath(new URL('../worker/agent', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
});
