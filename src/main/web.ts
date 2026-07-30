/**
 * 网页版独立入口：不启动 Electron，只跑 Express（静态页 + /qdrant 代理）
 *
 * 用法：
 *   npm run build:web
 *   HOST=0.0.0.0 PORT=4357 QDRANT_URL=http://127.0.0.1:6333 npm run start:web
 */
import { join } from 'path'
import { attachRendererStatic, startServer } from './server'

process.env.QDRANT_WEB_MODE = '1'

async function main() {
  const host = process.env.HOST || '0.0.0.0'
  const port = Number(process.env.PORT || 4357)
  const rendererDir = join(__dirname, '../renderer')

  attachRendererStatic(rendererDir)
  await startServer({ host, port })
  console.log(`[qdrant-web] 打开浏览器访问 http://${host === '0.0.0.0' ? '本机IP' : host}:${port}`)
}

main().catch((err) => {
  console.error('[qdrant-web] 启动失败', err)
  process.exit(1)
})
