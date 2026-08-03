import { QdrantClient } from '@qdrant/js-client-rest'

/** 开发态走 Vite 代理路径；也可在 UI 里改成直连地址 */
export const DEFAULT_QDRANT_URL = '/qdrant'

/**
 * 创建客户端。
 * - `/qdrant`：同源相对路径（开发走 Vite/Express 代理；线上走反代，勿拼 6333）
 * - `http://127.0.0.1:6333`：浏览器直连（需 Qdrant 允许 CORS）
 *
 * 注意：js-client-rest 在 url 未带端口时会默认 port=6333。
 * 线上 HTTPS 的 location.origin 通常无端口，必须显式 port=0，否则会请求 :6333。
 */
export function createClient(url: string) {
  const trimmed = url.trim() || DEFAULT_QDRANT_URL

  // 注意：构造函数 timeout 单位是毫秒（默认 300000）；单次请求参数才是秒
  const timeoutMs = 600_000

  if (trimmed.startsWith('/')) {
    const origin = new URL(window.location.origin)
    return new QdrantClient({
      url: window.location.origin,
      prefix: trimmed.replace(/^\//, ''),
      // 0 为 falsy，SDK 拼地址时不会附加端口（沿用 443/80）
      port: origin.port ? Number(origin.port) : 0,
      checkCompatibility: false,
      timeout: timeoutMs,
    })
  }

  return new QdrantClient({
    url: trimmed,
    checkCompatibility: false,
    timeout: timeoutMs,
  })
}

export type CollectionSummary = {
  name: string
}

export type PayloadSchemaType =
  | 'keyword'
  | 'integer'
  | 'float'
  | 'geo'
  | 'text'
  | 'bool'
  | 'datetime'
  | 'uuid'

export type PayloadIndexRow = {
  field: string
  dataType: string
  points: number
  params?: unknown
}

export type CollectionDetail = {
  name: string
  status: string
  pointsCount: number
  segmentsCount: number
  vectors: unknown
  indexedVectorsCount?: number
  indexes: PayloadIndexRow[]
}

export type PointRow = {
  id: string | number
  payload: Record<string, unknown> | null
  vector: unknown
  score?: number
}

export async function checkHealth(client: QdrantClient) {
  return client.versionInfo()
}

export async function listCollections(client: QdrantClient): Promise<CollectionSummary[]> {
  const res = await client.getCollections()
  return (res.collections ?? []).map((c) => ({ name: c.name }))
}

function parsePayloadIndexes(
  schema: Record<string, { data_type?: string; points?: number; params?: unknown }> | null | undefined,
): PayloadIndexRow[] {
  if (!schema) return []
  return Object.entries(schema)
    .map(([field, info]) => ({
      field,
      dataType: String(info?.data_type ?? 'unknown'),
      points: Number(info?.points ?? 0),
      params: info?.params ?? undefined,
    }))
    .sort((a, b) => a.field.localeCompare(b.field, 'zh-CN'))
}

export async function getCollection(
  client: QdrantClient,
  name: string,
): Promise<CollectionDetail> {
  const res = await client.getCollection(name)
  return {
    name,
    status: String(res.status ?? 'unknown'),
    pointsCount: Number(res.points_count ?? 0),
    segmentsCount: Number(res.segments_count ?? 0),
    vectors: res.config?.params?.vectors ?? null,
    indexedVectorsCount:
      res.indexed_vectors_count !== undefined
        ? Number(res.indexed_vectors_count)
        : undefined,
    indexes: parsePayloadIndexes(
      res.payload_schema as Record<
        string,
        { data_type?: string; points?: number; params?: unknown }
      > | null,
    ),
  }
}

export async function listPayloadIndexes(
  client: QdrantClient,
  name: string,
): Promise<PayloadIndexRow[]> {
  const detail = await getCollection(client, name)
  return detail.indexes
}

export async function createPayloadIndex(
  client: QdrantClient,
  collection: string,
  fieldName: string,
  fieldSchema: PayloadSchemaType,
): Promise<void> {
  const field = fieldName.trim()
  if (!field) throw new Error('请填写索引字段名')
  await client.createPayloadIndex(collection, {
    wait: true,
    field_name: field,
    field_schema: fieldSchema,
  })
}

export async function deletePayloadIndex(
  client: QdrantClient,
  collection: string,
  fieldName: string,
): Promise<void> {
  const field = fieldName.trim()
  if (!field) throw new Error('缺少索引字段名')
  await client.deletePayloadIndex(collection, field, { wait: true })
}

export type ScrollFilter = {
  must?: Array<{
    key: string
    match: { value: string | number | boolean }
  }>
}

function mapPoints(
  points: Array<{ id?: unknown; payload?: unknown; vector?: unknown; score?: number }>,
): PointRow[] {
  return (points ?? []).map((p) => ({
    id: p.id as string | number,
    payload: (p.payload as Record<string, unknown> | null) ?? null,
    vector: p.vector ?? null,
    score: typeof p.score === 'number' ? p.score : undefined,
  }))
}

export async function scrollPoints(
  client: QdrantClient,
  collection: string,
  options: {
    limit?: number
    offset?: string | number | null
    withVector?: boolean
    filter?: ScrollFilter | null
  } = {},
): Promise<{ points: PointRow[]; nextOffset: string | number | null }> {
  const res = await client.scroll(collection, {
    limit: options.limit ?? 20,
    offset: options.offset ?? undefined,
    with_payload: true,
    with_vector: options.withVector ?? false,
    ...(options.filter && (options.filter.must?.length ?? 0) > 0
      ? { filter: options.filter }
      : {}),
  })

  const next = res.next_page_offset
  return {
    points: mapPoints(res.points ?? []),
    nextOffset: next === undefined || next === null ? null : (next as string | number),
  }
}

export async function searchPoints(
  client: QdrantClient,
  collection: string,
  options: {
    vector: number[]
    limit?: number
    offset?: number
    withVector?: boolean
    filter?: ScrollFilter | null
  },
): Promise<PointRow[]> {
  const res = await client.search(collection, {
    vector: options.vector,
    limit: options.limit ?? 20,
    offset: options.offset ?? 0,
    with_payload: true,
    with_vector: options.withVector ?? false,
    ...(options.filter && (options.filter.must?.length ?? 0) > 0
      ? { filter: options.filter }
      : {}),
  })
  return mapPoints(res ?? [])
}

export async function retrievePoint(
  client: QdrantClient,
  collection: string,
  id: string | number,
): Promise<PointRow | null> {
  const res = await client.retrieve(collection, {
    ids: [id],
    with_payload: true,
    with_vector: true,
  })
  const p = res[0]
  if (!p) return null
  return {
    id: p.id as string | number,
    payload: (p.payload as Record<string, unknown> | null) ?? null,
    vector: p.vector ?? null,
  }
}

export type Distance = 'Cosine' | 'Euclid' | 'Dot' | 'Manhattan'

export type CreateCollectionInput = {
  name: string
  size: number
  distance: Distance
  onDisk?: boolean
}

export async function createCollection(
  client: QdrantClient,
  input: CreateCollectionInput,
): Promise<void> {
  const name = input.name.trim()
  if (!name) throw new Error('请填写 collection 名称')
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error('名称只能包含字母、数字、下划线、短横线')
  }
  if (!Number.isInteger(input.size) || input.size <= 0) {
    throw new Error('向量维度必须是正整数')
  }

  const exists = (await client.collectionExists(name)).exists
  if (exists) throw new Error(`collection「${name}」已存在`)

  await client.createCollection(name, {
    vectors: {
      size: input.size,
      distance: input.distance,
      ...(input.onDisk ? { on_disk: true } : {}),
    },
  })
}

export async function deletePoints(
  client: QdrantClient,
  collection: string,
  ids: Array<string | number>,
): Promise<void> {
  if (ids.length === 0) throw new Error('没有要删除的点')
  await client.delete(collection, {
    wait: true,
    points: ids,
  })
}

export async function overwritePointPayload(
  client: QdrantClient,
  collection: string,
  id: string | number,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.overwritePayload(collection, {
    wait: true,
    points: [id],
    payload,
  })
}

/** 把「字段=值」行转成 Qdrant filter */
export function buildScrollFilter(
  rows: Array<{ key: string; value: string }>,
): ScrollFilter | null {
  const must: NonNullable<ScrollFilter['must']> = []
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    const value = parseMatchValue(row.value)
    if (value === null) {
      throw new Error(`字段「${key}」的值不能是 null，请改用具体字符串/数字/布尔值`)
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`字段「${key}」的值类型不支持`)
    }
    must.push({
      key,
      match: { value },
    })
  }
  if (must.length === 0) return null
  return { must }
}

export function parseMatchValue(raw: string): unknown {
  const t = raw.trim()
  if (t === '') return ''
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t)
  return raw
}

export function parseVectorInput(raw: string): number[] {
  const text = raw.trim()
  if (!text) throw new Error('请粘贴向量数组，例如 [0.1, 0.2, ...]')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('向量不是合法 JSON 数组')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('向量必须是非空数组')
  }
  if (!parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('向量元素必须都是数字')
  }
  return parsed as number[]
}
