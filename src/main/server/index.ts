import cors from 'cors'
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { resolveQdrantStorage } from '../storageInfo'

/** 本地辅助 API（storage-info）；渲染进程开发端口仍为 4356 */
const PORT = 4357
const QDRANT_TARGET = 'http://127.0.0.1:6333'

const app = express()
app.use(cors())

app.get('/api/storage-info', (_req, res) => {
  res.json(resolveQdrantStorage())
})

app.use(
  '/qdrant',
  createProxyMiddleware({
    target: QDRANT_TARGET,
    changeOrigin: true,
    pathRewrite: { '^/qdrant': '' },
  }),
)

export const API_PORT = PORT

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`[qdrant-desk] http://127.0.0.1:${PORT}`)
      resolve()
    })
    server.on('error', reject)
  })
}

export function attachRendererStatic(distPath: string) {
  app.use(express.static(distPath))
  app.get(/.*/, (_req, res) => {
    res.sendFile('index.html', { root: distPath })
  })
}
