import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

export type CollectionDiskInfo = {
  name: string
  bytes: number
}

export type StorageInfo = {
  path: string
  exists: boolean
  source: string
  collectionsPath: string
  collections: string[]
  /** 整个 storage 目录占用 */
  totalBytes: number | null
  /** 各 collection 目录占用 */
  collectionSizes: CollectionDiskInfo[]
  note?: string
}

function runPs(command: string): string {
  return execSync(`powershell.exe -NoProfile -Command ${JSON.stringify(command)}`, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  }).trim()
}

function readStoragePathFromConfig(configFile: string): string | null {
  try {
    const text = fs.readFileSync(configFile, 'utf8')
    const m = text.match(/storage\s*:\s*[\s\S]*?path\s*:\s*["']?([^\s"'#]+)/)
    if (!m?.[1]) return null
    const raw = m[1].trim()
    if (path.isAbsolute(raw)) return raw
    return path.resolve(path.dirname(configFile), raw)
  } catch {
    return null
  }
}

function listCollectionDirs(storagePath: string): string[] {
  const dir = path.join(storagePath, 'collections')
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/** 递归统计目录字节数；单目录失败则跳过 */
function dirSizeBytes(root: string, maxEntries = 200_000): number {
  if (!fs.existsSync(root)) return 0
  let total = 0
  let seen = 0
  const stack = [root]

  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      seen += 1
      if (seen > maxEntries) return total
      const full = path.join(current, ent.name)
      try {
        if (ent.isDirectory()) {
          stack.push(full)
        } else if (ent.isFile() || ent.isSymbolicLink()) {
          total += fs.statSync(full).size
        }
      } catch {
        // ignore locked/missing files
      }
    }
  }
  return total
}

function withDiskSizes(base: Omit<StorageInfo, 'totalBytes' | 'collectionSizes'>): StorageInfo {
  if (!base.exists) {
    return { ...base, totalBytes: null, collectionSizes: [] }
  }

  const collectionSizes = base.collections
    .map((name) => ({
      name,
      bytes: dirSizeBytes(path.join(base.collectionsPath, name)),
    }))
    .sort((a, b) => b.bytes - a.bytes)

  const collectionsSum = collectionSizes.reduce((n, c) => n + c.bytes, 0)
  // 整库：优先扫 storage 根；失败则用 collections 合计
  let totalBytes = 0
  try {
    totalBytes = dirSizeBytes(base.path)
  } catch {
    totalBytes = collectionsSum
  }
  if (totalBytes <= 0 && collectionsSum > 0) totalBytes = collectionsSum

  return {
    ...base,
    totalBytes,
    collectionSizes,
  }
}

export function resolveQdrantStorage(): StorageInfo {
  if (process.env.QDRANT_STORAGE_PATH) {
    const p = path.resolve(process.env.QDRANT_STORAGE_PATH)
    return withDiskSizes({
      path: p,
      exists: fs.existsSync(p),
      source: '环境变量 QDRANT_STORAGE_PATH',
      collectionsPath: path.join(p, 'collections'),
      collections: listCollectionDirs(p),
    })
  }

  // Windows 桌面：探测本机 qdrant.exe；服务器/Linux 跳过
  if (process.platform === 'win32') {
    try {
      const exePath = runPs(
        "(Get-CimInstance Win32_Process -Filter \"name='qdrant.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath)",
      )
      const commandLine = runPs(
        "(Get-CimInstance Win32_Process -Filter \"name='qdrant.exe'\" | Select-Object -First 1 -ExpandProperty CommandLine)",
      )

      if (exePath) {
        const exeDir = path.dirname(exePath)
        let storagePath = path.join(exeDir, 'storage')
        let source = 'qdrant.exe 同目录 /storage'

        const configMatch = commandLine.match(/--config(?:=|\s+)["']?([^"'\s]+)/i)
        if (configMatch?.[1]) {
          const configFile = path.isAbsolute(configMatch[1])
            ? configMatch[1]
            : path.resolve(exeDir, configMatch[1])
          const fromConfig = readStoragePathFromConfig(configFile)
          if (fromConfig) {
            storagePath = fromConfig
            source = `配置文件 ${configFile}`
          }
        }

        return withDiskSizes({
          path: storagePath,
          exists: fs.existsSync(storagePath),
          source,
          collectionsPath: path.join(storagePath, 'collections'),
          collections: listCollectionDirs(storagePath),
          note: `进程：${exePath}`,
        })
      }
    } catch {
      // ignore and fallback
    }
  }

  const fallbacks = [
    path.resolve('D:/codes/storage'),
    path.resolve(process.cwd(), '../storage'),
    path.resolve(process.cwd(), '../../storage'),
    path.resolve(process.cwd(), 'storage'),
    path.resolve('/var/lib/qdrant/storage'),
    path.resolve('/qdrant/storage'),
  ]

  for (const p of fallbacks) {
    if (fs.existsSync(p)) {
      return withDiskSizes({
        path: p,
        exists: true,
        source: '本地常见路径探测',
        collectionsPath: path.join(p, 'collections'),
        collections: listCollectionDirs(p),
        note: '未检测到运行中的 qdrant.exe，结果可能不准确',
      })
    }
  }

  const guessed = path.resolve(process.cwd(), '../storage')
  return withDiskSizes({
    path: guessed,
    exists: false,
    source: '默认猜测',
    collectionsPath: path.join(guessed, 'collections'),
    collections: [],
    note: '未找到 Qdrant 数据目录，可设置环境变量 QDRANT_STORAGE_PATH',
  })
}
