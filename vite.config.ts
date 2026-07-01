import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const defaultApiPort = 3642;
const parsedPort = Number(process.env.PORT);
const apiPort = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : defaultApiPort;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true
  }
});
