import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

export type StorageInfo = {
  path: string
  exists: boolean
  source: string
  collectionsPath: string
  collections: string[]
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

export function resolveQdrantStorage(): StorageInfo {
  if (process.env.QDRANT_STORAGE_PATH) {
    const p = path.resolve(process.env.QDRANT_STORAGE_PATH)
    return {
      path: p,
      exists: fs.existsSync(p),
      source: '环境变量 QDRANT_STORAGE_PATH',
      collectionsPath: path.join(p, 'collections'),
      collections: listCollectionDirs(p),
    }
  }

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

      return {
        path: storagePath,
        exists: fs.existsSync(storagePath),
        source,
        collectionsPath: path.join(storagePath, 'collections'),
        collections: listCollectionDirs(storagePath),
        note: `进程：${exePath}`,
      }
    }
  } catch {
    // ignore and fallback
  }

  const fallbacks = [
    path.resolve('D:/codes/storage'),
    path.resolve(process.cwd(), '../storage'),
    path.resolve(process.cwd(), '../../storage'),
    path.resolve(process.cwd(), 'storage'),
  ]

  for (const p of fallbacks) {
    if (fs.existsSync(p)) {
      return {
        path: p,
        exists: true,
        source: '本地常见路径探测',
        collectionsPath: path.join(p, 'collections'),
        collections: listCollectionDirs(p),
        note: '未检测到运行中的 qdrant.exe，结果可能不准确',
      }
    }
  }

  const guessed = path.resolve(process.cwd(), '../storage')
  return {
    path: guessed,
    exists: false,
    source: '默认猜测',
    collectionsPath: path.join(guessed, 'collections'),
    collections: [],
    note: '未找到 Qdrant 数据目录，可设置环境变量 QDRANT_STORAGE_PATH',
  }
}
