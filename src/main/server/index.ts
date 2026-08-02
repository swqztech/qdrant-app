import cors from 'cors'
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { resolveQdrantStorage } from '../storageInfo'

/** 本地辅助 API（storage-info）；渲染进程开发端口仍为 4356 */
const DEFAULT_PORT = 4357
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_QDRANT = 'http://127.0.0.1:6333'

const app = express()
app.use(cors())

let proxyReady = false
let staticReady = false

function readPort() {
  const n = Number(process.env.PORT || DEFAULT_PORT)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT
}

function readHost() {
  return process.env.HOST || DEFAULT_HOST
}

function readQdrantTarget() {
  return (process.env.QDRANT_URL || DEFAULT_QDRANT).replace(/\/$/, '')
}

function ensureQdrantProxy() {
  if (proxyReady) return
  proxyReady = true
  const qdrantTarget = readQdrantTarget()
  app.use(
    '/qdrant',
    createProxyMiddleware({
      target: qdrantTarget,
      changeOrigin: true,
      pathRewrite: { '^/qdrant': '' }
    })
  )
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: process.env.QDRANT_WEB_MODE === '1' ? 'web' : 'desktop',
    qdrant: readQdrantTarget()
  })
})

app.get('/api/storage-info', (_req, res) => {
  try {
    res.json(resolveQdrantStorage())
  } catch (err) {
    res.status(500).json({
      path: '',
      exists: false,
      source: 'error',
      collectionsPath: '',
      collections: [],
      totalBytes: null,
      collectionSizes: [],
      note: err instanceof Error ? err.message : String(err)
    })
  }
})

export const API_PORT = readPort()

export function attachRendererStatic(distPath: string) {
  ensureQdrantProxy()
  if (staticReady) return
  staticReady = true
  app.use(express.static(distPath))
  app.get(/.*/, (_req, res) => {
    res.sendFile('index.html', { root: distPath })
  })
}

export function startServer(opts?: { host?: string; port?: number }): Promise<void> {
  ensureQdrantProxy()
  const host = opts?.host || readHost()
  const port = opts?.port || readPort()
  const qdrantTarget = readQdrantTarget()

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`[qdrant] http://${host}:${port}`)
      console.log(`[qdrant] proxy /qdrant -> ${qdrantTarget}`)
      resolve()
    })
    server.on('error', reject)
  })
}
