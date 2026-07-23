import type { QdrantClient } from '@qdrant/js-client-rest'
import type { PointRow } from './qdrant'

export const EXPORT_FORMAT = 'qdrant-viewer-export'
export const EXPORT_VERSION = 1

export type ExportPoint = {
  id: string | number
  payload: Record<string, unknown> | null
  vector: unknown
}

export type ExportCollection = {
  name: string
  vectors: unknown
  sparseVectors?: unknown
  points: ExportPoint[]
}

export type ExportBundle = {
  format: typeof EXPORT_FORMAT
  version: typeof EXPORT_VERSION
  exportedAt: string
  collections: ExportCollection[]
}

export type ProgressFn = (message: string) => void

const SCROLL_BATCH = 256
const UPSERT_BATCH = 64

/** 把 Qdrant / fetch 错误转成可读文案 */
export function formatQdrantError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err)
  const e = err as {
    message?: string
    status?: number
    statusText?: string
    data?: { status?: { error?: string } | string; error?: string }
  }
  const detail =
    (typeof e.data?.status === 'object' && e.data.status?.error) ||
    (typeof e.data?.status === 'string' ? e.data.status : '') ||
    e.data?.error ||
    ''
  const head = [e.status, e.statusText || e.message].filter(Boolean).join(' ')
  if (detail && head) return `${head}: ${detail}`
  if (detail) return detail
  if (e.message) return e.message
  return String(err)
}

/** 导出/导入时只保留创建 collection 需要的向量字段，避免脏配置导致 400 */
function sanitizeVectorParams(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (typeof v.size === 'number' && typeof v.distance === 'string') {
    const out: Record<string, unknown> = {
      size: v.size,
      distance: v.distance,
    }
    if (typeof v.on_disk === 'boolean') out.on_disk = v.on_disk
    if (typeof v.datatype === 'string') out.datatype = v.datatype
    if (v.hnsw_config && typeof v.hnsw_config === 'object') out.hnsw_config = v.hnsw_config
    if (v.quantization_config && typeof v.quantization_config === 'object') {
      out.quantization_config = v.quantization_config
    }
    if (v.multivector_config && typeof v.multivector_config === 'object') {
      out.multivector_config = v.multivector_config
    }
    return out
  }

  // 命名向量：{ name: VectorParams, ... }
  const named: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(v)) {
    const cleaned = sanitizeVectorParams(val)
    if (cleaned) named[key] = cleaned
  }
  return Object.keys(named).length > 0 ? named : null
}

function createArgs(col: ExportCollection) {
  const vectors = sanitizeVectorParams(col.vectors)
  if (!vectors) {
    throw new Error(`collection「${col.name}」的 vectors 配置无效，无法创建`)
  }
  return {
    vectors: vectors as never,
    ...(col.sparseVectors
      ? { sparse_vectors: col.sparseVectors as never }
      : {}),
  }
}

async function scrollAllPoints(
  client: QdrantClient,
  collection: string,
  onProgress?: ProgressFn,
): Promise<PointRow[]> {
  const all: PointRow[] = []
  let offset: string | number | null | undefined = undefined

  for (;;) {
    const res = await client.scroll(collection, {
      limit: SCROLL_BATCH,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: true,
    })
    const batch = (res.points ?? []).map((p) => ({
      id: p.id as string | number,
      payload: (p.payload as Record<string, unknown> | null) ?? null,
      vector: p.vector ?? null,
    }))
    all.push(...batch)
    onProgress?.(`导出 ${collection}：已读取 ${all.length} 个点…`)

    const next = res.next_page_offset
    if (next === undefined || next === null) break
    offset = next as string | number
  }

  return all
}

export async function buildCollectionExport(
  client: QdrantClient,
  name: string,
  onProgress?: ProgressFn,
): Promise<ExportCollection> {
  onProgress?.(`读取 collection 配置：${name}`)
  const info = await client.getCollection(name)
  const vectors = sanitizeVectorParams(info.config?.params?.vectors ?? null)
  const sparseVectors = info.config?.params?.sparse_vectors ?? undefined
  const points = await scrollAllPoints(client, name, onProgress)

  return {
    name,
    vectors,
    sparseVectors: sparseVectors ?? undefined,
    points: points.map((p) => ({
      id: p.id,
      payload: p.payload,
      vector: p.vector,
    })),
  }
}

export async function exportCollections(
  client: QdrantClient,
  names: string[],
  onProgress?: ProgressFn,
): Promise<ExportBundle> {
  const collections: ExportCollection[] = []
  for (const name of names) {
    collections.push(await buildCollectionExport(client, name, onProgress))
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    collections,
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function isExportBundle(value: unknown): value is ExportBundle {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.format !== EXPORT_FORMAT) return false
  if (!Array.isArray(v.collections)) return false
  return true
}

/** 兼容：直接是单个 collection，或完整 bundle */
export function normalizeImportData(raw: unknown): ExportCollection[] {
  if (isExportBundle(raw)) {
    return raw.collections
  }
  if (raw && typeof raw === 'object') {
    const v = raw as Record<string, unknown>
    if (typeof v.name === 'string' && Array.isArray(v.points)) {
      return [v as unknown as ExportCollection]
    }
  }
  throw new Error('无法识别的导入文件。请使用本工具导出的 JSON。')
}

export type ImportOptions = {
  /**
   * true：清空已有点后再写入（不删 collection，避免 Windows 删目录拒绝访问）
   * false：直接 upsert 合并
   */
  clearPoints: boolean
}

function isOrphanCreateError(err: unknown): boolean {
  const msg = formatQdrantError(err)
  return /already exists|Can't create collection|Conflict|Wrong input|Bad Request/i.test(
    msg,
  )
}

function isAccessDeniedError(err: unknown): boolean {
  const msg = formatQdrantError(err)
  return /拒绝访问|Access is denied|os error 5|AccessDenied/i.test(msg)
}

/** 清空 collection 内全部点（保留库结构，不删磁盘目录） */
async function clearAllPoints(
  client: QdrantClient,
  name: string,
  onProgress?: ProgressFn,
) {
  onProgress?.(`清空「${name}」中的全部点…`)
  // 空 filter 匹配全部点
  await client.delete(name, {
    wait: true,
    filter: {},
  })
}

/**
 * 确保目标 collection 可写入。
 * 「清空后导入」改为删点而不是 recreateCollection，规避 Windows 文件占用。
 */
async function ensureCollection(
  client: QdrantClient,
  col: ExportCollection,
  clearPoints: boolean,
  onProgress?: ProgressFn,
) {
  const args = createArgs(col)
  const exists = (await client.collectionExists(col.name)).exists

  if (exists && clearPoints) {
    try {
      await clearAllPoints(client, col.name, onProgress)
    } catch (err) {
      throw new Error(
        `清空「${col.name}」的点失败：${formatQdrantError(err)}。可改用「合并导入」，或重启 Qdrant 后再试。`,
      )
    }
    return
  }

  if (exists) {
    onProgress?.(`合并导入到已有 collection：${col.name}`)
    return
  }

  onProgress?.(`创建 collection：${col.name}`)
  try {
    await client.createCollection(col.name, args)
  } catch (err) {
    if (isAccessDeniedError(err)) {
      throw new Error(
        `创建「${col.name}」被拒绝访问（Windows 文件占用）。请先关闭占用该目录的程序，或重启 Qdrant 后再导入。原文：${formatQdrantError(err)}`,
      )
    }
    if (!isOrphanCreateError(err)) throw err

    // 残留目录：尽量 delete 后再 create；失败则给出可操作提示，不再强行 recreate
    onProgress?.(`检测到残留存储，尝试清理：${col.name}`)
    try {
      await client.deleteCollection(col.name)
    } catch (delErr) {
      if (isAccessDeniedError(delErr)) {
        throw new Error(
          `清理残留「${col.name}」失败：拒绝访问。请重启 Qdrant 服务后再导入。`,
        )
      }
    }
    try {
      await client.createCollection(col.name, args)
    } catch (createErr) {
      throw new Error(
        `创建「${col.name}」仍失败：${formatQdrantError(createErr)}。请重启 Qdrant 后再试。`,
      )
    }
  }
}

export async function importCollections(
  client: QdrantClient,
  collections: ExportCollection[],
  options: ImportOptions,
  onProgress?: ProgressFn,
): Promise<{ name: string; points: number }[]> {
  const results: { name: string; points: number }[] = []

  for (const col of collections) {
    if (!col.name) throw new Error('导入数据缺少 collection 名称')

    try {
      await ensureCollection(client, col, options.clearPoints, onProgress)
    } catch (err) {
      throw new Error(
        `准备 collection「${col.name}」失败：${formatQdrantError(err)}`,
      )
    }

    const points = col.points ?? []
    for (let i = 0; i < points.length; i += UPSERT_BATCH) {
      const chunk = points.slice(i, i + UPSERT_BATCH)
      try {
        await client.upsert(col.name, {
          wait: true,
          points: chunk.map((p) => ({
            id: p.id,
            vector: (p.vector ?? undefined) as never,
            payload: p.payload ?? undefined,
          })),
        })
      } catch (err) {
        throw new Error(
          `写入「${col.name}」失败（已处理 ${i}/${points.length}）：${formatQdrantError(err)}`,
        )
      }
      onProgress?.(
        `导入 ${col.name}：${Math.min(i + chunk.length, points.length)} / ${points.length}`,
      )
    }

    results.push({ name: col.name, points: points.length })
  }

  return results
}
