import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          web: resolve('src/main/web.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    server: {
      port: 4356,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4357',
          changeOrigin: true
        },
        '/qdrant': {
          target: 'http://127.0.0.1:6333',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/qdrant/, ''),
          timeout: 600_000
        }
      }
    }
  }
})
