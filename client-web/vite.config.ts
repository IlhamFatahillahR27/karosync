import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const signalingTarget = process.env.VITE_DEV_SIGNALING_TARGET || 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/ws': {
        target: signalingTarget,
        ws: true,
        changeOrigin: true,
      },
      '/health': {
        target: signalingTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
  },
});
