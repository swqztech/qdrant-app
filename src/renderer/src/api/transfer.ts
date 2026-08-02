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

const SCROLL_BATCH = 64
const UPSERT_BATCH = 64
/** 导出时合并小片段，避免 BlobPart 过多 */
const EXPORT_FLUSH_EVERY = 40

/** 超过此大小走流式导入，避免 file.text() / JSON.parse 触发 Invalid string length */
export const IMPORT_STREAM_THRESHOLD = 24 * 1024 * 1024

/** 把 Qdrant / fetch 错误转成可读文案 */
export function formatQdrantError(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) {
    if (/Invalid string length|string longer than|Maximum call stack/i.test(err.message)) {
      return '文件过大，浏览器无法整文件解析。请重新选择该文件（将自动改用流式导入），或拆成更小的导出后再试。'
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(err.message)) {
      return '网络请求失败（Failed to fetch）。请确认 /qdrant 代理与 Qdrant 服务可用。'
    }
  }
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

function triggerBlobDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadJson(filename: string, data: unknown) {
  // 紧凑 JSON，避免 pretty-print 撑爆大库
  triggerBlobDownload(
    filename,
    new Blob([JSON.stringify(data)], {
      type: 'application/json;charset=utf-8',
    }),
  )
}

class JsonBlobBuilder {
  private parts: BlobPart[] = []
  private buf: string[] = []
  private bufCount = 0

  push(text: string) {
    this.buf.push(text)
    this.bufCount += 1
    if (this.bufCount >= EXPORT_FLUSH_EVERY) this.flush()
  }

  flush() {
    if (this.buf.length === 0) return
    this.parts.push(this.buf.join(''))
    this.buf = []
    this.bufCount = 0
  }

  toBlob() {
    this.flush()
    return new Blob(this.parts, { type: 'application/json;charset=utf-8' })
  }
}

/**
 * 流式导出大库：边 scroll 边写入 Blob 分片，避免整包 JSON.stringify 触发
 * “Invalid string length / 参数过长”之类错误。
 */
export async function exportCollectionsStreaming(
  client: QdrantClient,
  names: string[],
  filename: string,
  onProgress?: ProgressFn,
): Promise<{ collections: number; points: number; bytes: number }> {
  if (names.length === 0) throw new Error('没有可导出的 collection')

  const builder = new JsonBlobBuilder()
  const exportedAt = new Date().toISOString()
  builder.push(
    `{"format":${JSON.stringify(EXPORT_FORMAT)},"version":${EXPORT_VERSION},"exportedAt":${JSON.stringify(exportedAt)},"collections":[`,
  )

  let totalPoints = 0

  for (let ci = 0; ci < names.length; ci += 1) {
    const name = names[ci]!
    if (ci > 0) builder.push(',')

    onProgress?.(`读取 collection 配置：${name}`)
    const info = await client.getCollection(name)
    const vectors = sanitizeVectorParams(info.config?.params?.vectors ?? null)
    if (!vectors) {
      throw new Error(`collection「${name}」的 vectors 配置无效，无法导出`)
    }
    const sparseVectors = info.config?.params?.sparse_vectors ?? undefined

    builder.push(`{"name":${JSON.stringify(name)},"vectors":${JSON.stringify(vectors)}`)
    if (sparseVectors != null) {
      builder.push(`,"sparseVectors":${JSON.stringify(sparseVectors)}`)
    }
    builder.push(`,"points":[`)

    let firstPoint = true
    let offset: string | number | null | undefined = undefined
    let count = 0

    for (;;) {
      const res = await client.scroll(name, {
        limit: SCROLL_BATCH,
        offset: offset ?? undefined,
        with_payload: true,
        with_vector: true,
      })

      for (const p of res.points ?? []) {
        if (!firstPoint) builder.push(',')
        firstPoint = false
        builder.push(
          JSON.stringify({
            id: p.id,
            payload: p.payload ?? null,
            vector: p.vector ?? null,
          }),
        )
        count += 1
      }

      onProgress?.(`导出 ${name}：已写入 ${count.toLocaleString()} 个点…`)
      const next = res.next_page_offset
      if (next === undefined || next === null) break
      offset = next as string | number
    }

    builder.push(']}')
    totalPoints += count
  }

  builder.push(']}')
  onProgress?.('正在打包下载文件…')
  const blob = builder.toBlob()
  triggerBlobDownload(filename, blob)

  return {
    collections: names.length,
    points: totalPoints,
    bytes: blob.size,
  }
}

function isExportBundle(value: unknown): value is ExportBundle {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.format !== EXPORT_FORMAT) return false
  if (!Array.isArray(v.collections)) return false
  return true
}

function looksLikeCollection(value: unknown): value is ExportCollection {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.name === 'string' && Array.isArray(v.points)
}

/** 兼容：直接是单个 collection，或完整 bundle */
export function normalizeImportData(raw: unknown): ExportCollection[] {
  if (isExportBundle(raw)) {
    return raw.collections
  }
  if (raw && typeof raw === 'object') {
    const v = raw as Record<string, unknown>
    // 有 collections 数组但缺 format 时也尽量接受
    if (Array.isArray(v.collections)) {
      const cols = v.collections.filter(looksLikeCollection)
      if (cols.length > 0) return cols
      throw new Error(
        '导入文件的 collections 为空或结构不正确（每项需要 name + points）。',
      )
    }
    if (looksLikeCollection(v)) {
      return [v]
    }
    const keys = Object.keys(v).slice(0, 8).join(', ') || '（无）'
    throw new Error(
      `无法识别的导入文件（顶层字段：${keys}）。请使用本工具「导出」生成的 JSON。`,
    )
  }
  throw new Error('无法识别的导入文件。请使用本工具导出的 JSON。')
}

/** 找到从 start 起一个完整 JSON 值的结束下标（不含其后字符）；数据不足返回 null */
function findJsonValueEnd(s: string, start: number): number | null {
  let i = start
  const n = s.length
  while (i < n && /\s/.test(s[i]!)) i += 1
  if (i >= n) return null

  const ch = s[i]!
  if (ch === '"') {
    i += 1
    while (i < n) {
      const c = s[i]!
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '"') return i + 1
      i += 1
    }
    return null
  }

  if (ch === '{' || ch === '[') {
    const open = ch
    const close = ch === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    while (i < n) {
      const c = s[i]!
      if (inStr) {
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '"') inStr = false
        i += 1
        continue
      }
      if (c === '"') {
        inStr = true
        i += 1
        continue
      }
      if (c === open) depth += 1
      else if (c === close) {
        depth -= 1
        if (depth === 0) return i + 1
      }
      i += 1
    }
    return null
  }

  // number / true / false / null
  while (i < n && !/[\s,\]}]/.test(s[i]!)) i += 1
  return i > start ? i : null
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i += 1
  return i
}

export type ImportPreviewCollection = {
  name: string
  /** null 表示大文件流式预览，点数待导入时统计 */
  points: number | null
}

export type ImportFilePlan = {
  fileName: string
  fileSize: number
  stream: boolean
  preview: ImportPreviewCollection[]
  /** 小文件已完整解析；大文件为 null，确认后按 file 流式导入 */
  parsed: ExportCollection[] | null
}

/**
 * 检查导入文件：小文件整包解析；大文件只校验头部并走流式导入。
 */
export async function inspectImportFile(file: File): Promise<ImportFilePlan> {
  const base = {
    fileName: file.name,
    fileSize: file.size,
  }

  const tryMemory = file.size <= IMPORT_STREAM_THRESHOLD
  if (tryMemory) {
    try {
      const text = await file.text()
      const collections = normalizeImportData(JSON.parse(text) as unknown)
      if (collections.length === 0) throw new Error('导入文件里没有 collection')
      return {
        ...base,
        stream: false,
        parsed: collections,
        preview: collections.map((c) => ({
          name: c.name,
          points: c.points?.length ?? 0,
        })),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/Invalid string length|string longer than|Out of memory/i.test(msg)) {
        throw err
      }
      // 回退流式
    }
  }

  const preview = await peekExportBundle(file)
  return {
    ...base,
    stream: true,
    parsed: null,
    preview,
  }
}

/** 只读文件头部，校验 format 并取出第一个 collection 的 name（用于确认框） */
async function peekExportBundle(file: File): Promise<ImportPreviewCollection[]> {
  const headSize = Math.min(file.size, 1024 * 1024)
  const head = await file.slice(0, headSize).text()
  const trimmed = head.replace(/^\uFEFF/, '')

  if (!trimmed.includes(`"format":"${EXPORT_FORMAT}"`)) {
    // 兼容有空格的 pretty JSON
    if (!/"format"\s*:\s*"qdrant-viewer-export"/.test(trimmed)) {
      throw new Error(
        '无法识别的导入文件（缺少 format: qdrant-viewer-export）。请使用本工具导出的 JSON。',
      )
    }
  }

  const marker = '"collections"'
  const ci = trimmed.indexOf(marker)
  if (ci < 0) {
    throw new Error('无法识别的导入文件（缺少 collections）。请使用本工具导出的 JSON。')
  }

  const pointsMatch = trimmed.match(/,\s*"points"\s*:\s*\[/)
  if (!pointsMatch || pointsMatch.index == null) {
    // 头部还没读到 points：可能 vectors 极大（极少见），仍允许流式导入
    const nameMatch = trimmed.match(/"name"\s*:\s*"((?:\\.|[^"\\])*)"/)
    if (nameMatch?.[1]) {
      return [{ name: JSON.parse(`"${nameMatch[1]}"`) as string, points: null }]
    }
    return [{ name: '(流式导入)', points: null }]
  }

  // 从 collections 数组第一个 { 起截到 points 之前，拼成完整对象
  const afterCollections = trimmed.slice(ci)
  const brace = afterCollections.indexOf('{')
  if (brace < 0) {
    throw new Error('无法识别的导入文件（collections 结构损坏）。')
  }
  const absBrace = ci + brace
  const pk = pointsMatch.index
  const metaJson = `${trimmed.slice(absBrace, pk)}}`
  try {
    const meta = JSON.parse(metaJson) as { name?: string }
    if (typeof meta.name !== 'string' || !meta.name) {
      throw new Error('bad name')
    }
    return [{ name: meta.name, points: null }]
  } catch {
    throw new Error('无法识别的导入文件（collection 头部解析失败）。文件可能已损坏。')
  }
}

type StreamCollMeta = {
  name: string
  vectors: unknown
  sparseVectors?: unknown
}

/**
 * 流式读取导出 JSON，按 collection 产出元数据与点批次（不把整文件装进内存）。
 */
async function* iterateExportFile(
  file: File,
): AsyncGenerator<
  | { type: 'collection'; meta: StreamCollMeta }
  | { type: 'points'; points: ExportPoint[] }
  | { type: 'collection-end' }
> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  let eof = false

  const ensure = async (minLen: number) => {
    while (buf.length < minLen && !eof) {
      const { done, value } = await reader.read()
      if (done) {
        eof = true
        break
      }
      buf += value
    }
  }

  const pull = async () => {
    if (eof) return
    const { done, value } = await reader.read()
    if (done) {
      eof = true
      return
    }
    buf += value
  }

  try {
    await ensure(64)
    buf = buf.replace(/^\uFEFF/, '')

    // 定位 collections 数组
    for (;;) {
      const m = buf.match(/"collections"\s*:\s*\[/)
      if (m && m.index != null) {
        buf = buf.slice(m.index + m[0].length)
        break
      }
      if (eof) {
        throw new Error('无法识别的导入文件（缺少 collections 数组）。')
      }
      await pull()
    }

    // 解析每个 collection
    for (;;) {
      await ensure(1)
      buf = buf.slice(skipWs(buf, 0))
      if (buf.startsWith(']')) {
        buf = buf.slice(1)
        break
      }
      if (buf.startsWith(',')) {
        buf = buf.slice(1)
        continue
      }
      if (!buf.startsWith('{')) {
        if (eof) break
        await pull()
        continue
      }

      // 读到 ,"points": [ 得到 meta（兼容空白）
      for (;;) {
        const pointsMatch = buf.match(/,\s*"points"\s*:\s*\[/)
        if (pointsMatch && pointsMatch.index != null) {
          const pk = pointsMatch.index
          const metaJson = `${buf.slice(0, pk)}}`
          let meta: StreamCollMeta
          try {
            const parsed = JSON.parse(metaJson) as Record<string, unknown>
            if (typeof parsed.name !== 'string') throw new Error('no name')
            meta = {
              name: parsed.name,
              vectors: parsed.vectors,
              sparseVectors: parsed.sparseVectors,
            }
          } catch {
            throw new Error('导入文件 collection 头部无效（name/vectors/points）。')
          }
          buf = buf.slice(pk + pointsMatch[0].length)
          yield { type: 'collection', meta }
          break
        }
        if (eof) {
          throw new Error('导入文件不完整：collection 未找到 points 数组。')
        }
        await pull()
      }

      // 读 points 数组元素
      let batch: ExportPoint[] = []
      for (;;) {
        await ensure(1)
        let i = skipWs(buf, 0)
        buf = buf.slice(i)
        if (buf.startsWith(']')) {
          buf = buf.slice(1)
          if (batch.length > 0) {
            yield { type: 'points', points: batch }
            batch = []
          }
          // collection 对象还应有结尾 }
          await ensure(1)
          i = skipWs(buf, 0)
          buf = buf.slice(i)
          if (buf.startsWith('}')) buf = buf.slice(1)
          yield { type: 'collection-end' }
          break
        }
        if (buf.startsWith(',')) {
          buf = buf.slice(1)
          continue
        }

        let end = findJsonValueEnd(buf, 0)
        while (end == null && !eof) {
          await pull()
          end = findJsonValueEnd(buf, 0)
        }
        if (end == null) {
          throw new Error('导入文件不完整：points 数组被截断。')
        }
        let point: ExportPoint
        try {
          point = JSON.parse(buf.slice(0, end)) as ExportPoint
        } catch {
          throw new Error('导入文件中某个 point JSON 无效。')
        }
        buf = buf.slice(end)
        batch.push(point)
        if (batch.length >= UPSERT_BATCH) {
          yield { type: 'points', points: batch }
          batch = []
        }

        // 控制缓冲区，避免无限增长
        if (buf.length > 8 * 1024 * 1024) {
          // 正常情况下应持续消费；若仍过大说明结构异常
          throw new Error('导入解析缓冲区过大，文件格式可能损坏。')
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

/**
 * 流式导入本工具导出的大 JSON（边读边 upsert）。
 */
export async function importExportFileStreaming(
  client: QdrantClient,
  file: File,
  options: ImportOptions,
  onProgress?: ProgressFn,
): Promise<{ name: string; points: number }[]> {
  const results: { name: string; points: number }[] = []
  let current: StreamCollMeta | null = null
  let written = 0

  for await (const ev of iterateExportFile(file)) {
    if (ev.type === 'collection') {
      current = ev.meta
      written = 0
      const col: ExportCollection = {
        name: current.name,
        vectors: current.vectors,
        sparseVectors: current.sparseVectors,
        points: [],
      }
      try {
        await ensureCollection(client, col, options.clearPoints, onProgress)
      } catch (err) {
        throw new Error(
          `准备 collection「${col.name}」失败：${formatQdrantError(err)}`,
        )
      }
      onProgress?.(`开始导入 ${current.name}…`)
    } else if (ev.type === 'points') {
      if (!current) throw new Error('导入状态异常：尚未进入 collection')
      try {
        await client.upsert(current.name, {
          wait: true,
          points: ev.points.map((p) => ({
            id: p.id,
            vector: (p.vector ?? undefined) as never,
            payload: p.payload ?? undefined,
          })),
        })
      } catch (err) {
        throw new Error(
          `写入「${current.name}」失败（已处理 ${written}）：${formatQdrantError(err)}`,
        )
      }
      written += ev.points.length
      onProgress?.(
        `导入 ${current.name}：已写入 ${written.toLocaleString()} 个点…`,
      )
    } else if (ev.type === 'collection-end') {
      if (current) {
        results.push({ name: current.name, points: written })
        current = null
      }
    }
  }

  if (results.length === 0) {
    throw new Error('导入文件里没有 collection')
  }
  return results
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
