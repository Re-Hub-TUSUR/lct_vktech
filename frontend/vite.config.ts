import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// В docker-compose.dev.yml API доступно как http://backend:8000, при локальном запуске — localhost.
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:8000'
const usePolling = process.env.VITE_USE_POLLING === 'true'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true },
    },
  },
})
