import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_QDRANT_URL,
  buildScrollFilter,
  createClient,
  createCollection,
  createPayloadIndex,
  checkHealth,
  deletePayloadIndex,
  deletePoints,
  listCollections,
  getCollection,
  overwritePointPayload,
  parseVectorInput,
  scrollPoints,
  searchPoints,
  retrievePoint,
  type CollectionDetail,
  type CollectionSummary,
  type Distance,
  type PayloadSchemaType,
  type PointRow,
  type ScrollFilter,
} from './api/qdrant'
import {
  IMPORT_STREAM_THRESHOLD,
  exportCollectionsStreaming,
  formatQdrantError,
  importCollections,
  importExportFileStreaming,
  inspectImportFile,
  type ImportFilePlan,
} from './api/transfer'
import { useDialog } from './dialogs'
import { IO_TOAST, toast } from './toast'
import './App.css'

type PendingImport = ImportFilePlan & { file: File }

type StorageInfo = {
  path: string
  exists: boolean
  source: string
  collectionsPath: string
  collections: string[]
  totalBytes?: number | null
  collectionSizes?: { name: string; bytes: number }[]
  note?: string
}

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = -1
  do {
    n /= 1024
    i += 1
  } while (n >= 1024 && i < units.length - 1)
  return `${n.toFixed(n >= 100 || i === 0 ? 1 : 2)} ${units[i]}`
}

const PAGE_SIZE = 20
const SELECTED_STORAGE_KEY = 'qdrant-viewer-selected-collection'
const PINNED_STORAGE_KEY = 'qdrant-viewer-pinned-collections'

type QueryRow = { id: string; key: string; value: string }

function newQueryRow(): QueryRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    key: '',
    value: '',
  }
}

function readSelectedCollection(): string | null {
  try {
    const name = localStorage.getItem(SELECTED_STORAGE_KEY)
    return name && name.trim() ? name : null
  } catch {
    return null
  }
}

function writeSelectedCollection(name: string | null) {
  try {
    if (!name) localStorage.removeItem(SELECTED_STORAGE_KEY)
    else localStorage.setItem(SELECTED_STORAGE_KEY, name)
  } catch {
    // ignore
  }
}

function readPinnedCollections(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((name): name is string => typeof name === 'string')
  } catch {
    return []
  }
}

function writePinnedCollections(names: string[]) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(names))
  } catch {
    // ignore
  }
}

function copyText(text: string, okMsg = '已复制') {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error('复制失败'),
  )
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function payloadPreview(payload: Record<string, unknown> | null): string {
  if (!payload || Object.keys(payload).length === 0) return '—'
  const text = JSON.stringify(payload)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function vectorSummary(vector: unknown): string {
  if (vector == null) return '未加载'
  if (Array.isArray(vector)) return `${vector.length} 维`
  if (typeof vector === 'object') {
    const keys = Object.keys(vector as object)
    return `${keys.length} 个命名向量`
  }
  return typeof vector
}

function formatCellValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return formatJson(value)
}

function PayloadTable({ payload }: { payload: Record<string, unknown> | null }) {
  const entries = Object.entries(payload ?? {})

  if (entries.length === 0) {
    return <p className="empty">没有 payload 字段</p>
  }

  return (
    <div className="kv-table-wrap">
      <table className="kv-table">
        <thead>
          <tr>
            <th>字段</th>
            <th>值</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <td className="kv-key">{key}</td>
              <td className="kv-value">{formatCellValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function App() {
  const dialog = useDialog()
  const [url, setUrl] = useState(DEFAULT_QDRANT_URL)
  const [urlDraft, setUrlDraft] = useState(DEFAULT_QDRANT_URL)
  const [connected, setConnected] = useState(false)
  const [version, setVersion] = useState('')
  const [loading, setLoading] = useState(false)

  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [pinnedCollections, setPinnedCollections] = useState<string[]>(() =>
    readPinnedCollections(),
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [restoreName, setRestoreName] = useState<string | null>(null)
  const [detail, setDetail] = useState<CollectionDetail | null>(null)
  const [mainTab, setMainTab] = useState<'points' | 'indexes'>('points')
  const [indexField, setIndexField] = useState('')
  const [indexType, setIndexType] = useState<PayloadSchemaType>('keyword')
  const [indexBusy, setIndexBusy] = useState(false)

  const [points, setPoints] = useState<PointRow[]>([])
  const [nextOffset, setNextOffset] = useState<string | number | null>(null)
  const [offsetStack, setOffsetStack] = useState<(string | number | null)[]>([null])
  const [pageIndex, setPageIndex] = useState(0)
  const [withVector, setWithVector] = useState(false)
  const [pointsLoading, setPointsLoading] = useState(false)

  const [lookupId, setLookupId] = useState('')
  const [activePoint, setActivePoint] = useState<PointRow | null>(null)
  const [payloadDraft, setPayloadDraft] = useState('{}')
  const [pointBusy, setPointBusy] = useState(false)

  const [queryRows, setQueryRows] = useState<QueryRow[]>([newQueryRow()])
  const [activeFilter, setActiveFilter] = useState<ScrollFilter | null>(null)
  const [vectorQuery, setVectorQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'browse' | 'vector'>('browse')

  const [ioBusy, setIoBusy] = useState(false)
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createSize, setCreateSize] = useState('512')
  const [createDistance, setCreateDistance] = useState<Distance>('Cosine')
  const [createOnDisk, setCreateOnDisk] = useState(true)
  const [createBusy, setCreateBusy] = useState(false)
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  const client = useMemo(() => createClient(url), [url])
  const reportProgress = useCallback((message: string) => {
    toast.loading(message, IO_TOAST)
  }, [])

  const sortedCollections = useMemo(() => {
    const pinnedSet = new Set(pinnedCollections)
    const pinned = pinnedCollections
      .map((name) => collections.find((c) => c.name === name))
      .filter((c): c is CollectionSummary => Boolean(c))
    const rest = collections
      .filter((c) => !pinnedSet.has(c.name))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    return [...pinned, ...rest]
  }, [collections, pinnedCollections])

  const togglePinCollection = (name: string) => {
    setPinnedCollections((prev) => {
      const next = prev.includes(name)
        ? prev.filter((n) => n !== name)
        : [name, ...prev.filter((n) => n !== name)]
      writePinnedCollections(next)
      return next
    })
  }

  const loadStorageInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/storage-info')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStorageInfo((await res.json()) as StorageInfo)
    } catch {
      setStorageInfo(null)
    }
  }, [])

  const connect = useCallback(
    async (targetUrl: string, options?: { select?: string | null }) => {
      setLoading(true)
      try {
        const c = createClient(targetUrl)
        const health = await checkHealth(c)
        const cols = await listCollections(c)
        setUrl(targetUrl)
        setConnected(true)
        setVersion(health.version ?? 'ok')
        setCollections(cols)

        const want =
          options && 'select' in options
            ? options.select ?? null
            : readSelectedCollection()

        if (want && cols.some((col) => col.name === want)) {
          setRestoreName(want)
        } else {
          setRestoreName(null)
          setSelected(null)
          setDetail(null)
          setPoints([])
          setActivePoint(null)
          setNextOffset(null)
          setOffsetStack([null])
          setPageIndex(0)
          writeSelectedCollection(null)
        }
      } catch (e) {
        setConnected(false)
        setVersion('')
        setCollections([])
        setRestoreName(null)
        toast.error(formatQdrantError(e))
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void connect(DEFAULT_QDRANT_URL)
    void loadStorageInfo()
  }, [connect, loadStorageInfo])

  useEffect(() => {
    if (!activePoint && !pendingImport && !createOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || ioBusy || createBusy || pointBusy) return
      if (createOpen) setCreateOpen(false)
      else if (pendingImport) setPendingImport(null)
      else setActivePoint(null)
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [activePoint, pendingImport, createOpen, ioBusy, createBusy, pointBusy])

  const loadCollection = useCallback(
    async (name: string, options?: { filter?: ScrollFilter | null; resetQuery?: boolean }) => {
      setSelected(name)
      writeSelectedCollection(name)
      setActivePoint(null)
      setPointsLoading(true)
      setOffsetStack([null])
      setPageIndex(0)
      setSearchMode('browse')
      if (options?.resetQuery) {
        setQueryRows([newQueryRow()])
        setActiveFilter(null)
        setVectorQuery('')
        setMainTab('points')
        setIndexField('')
        setIndexType('keyword')
      }
      const filter =
        options && 'filter' in options ? (options.filter ?? null) : activeFilter
      try {
        const info = await getCollection(client, name)
        setDetail(info)
        const page = await scrollPoints(client, name, {
          limit: PAGE_SIZE,
          offset: null,
          withVector,
          filter,
        })
        setPoints(page.points)
        setNextOffset(page.nextOffset)
        if (options && 'filter' in options) setActiveFilter(filter)
      } catch (e) {
        setDetail(null)
        setPoints([])
        toast.error(formatQdrantError(e))
      } finally {
        setPointsLoading(false)
      }
    },
    [client, withVector, activeFilter],
  )

  useEffect(() => {
    if (!restoreName || !connected) return
    const name = restoreName
    setRestoreName(null)
    void loadCollection(name, { resetQuery: true, filter: null })
  }, [restoreName, connected, loadCollection])

  const loadPage = useCallback(
    async (offset: string | number | null, stack: (string | number | null)[], index: number) => {
      if (!selected || searchMode === 'vector') return
      setPointsLoading(true)
      try {
        const page = await scrollPoints(client, selected, {
          limit: PAGE_SIZE,
          offset,
          withVector,
          filter: activeFilter,
        })
        setPoints(page.points)
        setNextOffset(page.nextOffset)
        setOffsetStack(stack)
        setPageIndex(index)
        setActivePoint(null)
      } catch (e) {
        toast.error(formatQdrantError(e))
      } finally {
        setPointsLoading(false)
      }
    },
    [client, selected, withVector, activeFilter, searchMode],
  )

  const goNext = () => {
    if (nextOffset == null) return
    const stack = [...offsetStack.slice(0, pageIndex + 1), nextOffset]
    void loadPage(nextOffset, stack, pageIndex + 1)
  }

  const goPrev = () => {
    if (pageIndex <= 0) return
    const prevOffset = offsetStack[pageIndex - 1] ?? null
    void loadPage(prevOffset, offsetStack, pageIndex - 1)
  }

  const refreshPoints = () => {
    if (!selected) return
    void loadCollection(selected)
  }

  const openPoint = async (row: PointRow) => {
    if (!selected) return
    const show = (p: PointRow) => {
      setActivePoint(p)
      setPayloadDraft(formatJson(p.payload ?? {}))
    }
    if (row.vector != null) {
      show(row)
      return
    }
    try {
      const full = await retrievePoint(client, selected, row.id)
      show(full ?? row)
    } catch (e) {
      toast.error(formatQdrantError(e))
      show(row)
    }
  }

  const lookupPoint = async () => {
    if (!selected || !lookupId.trim()) return
    try {
      const id: string | number = /^\d+$/.test(lookupId.trim())
        ? Number(lookupId.trim())
        : lookupId.trim()
      const point = await retrievePoint(client, selected, id)
      if (!point) {
        toast.warning(`未找到点 ID: ${lookupId.trim()}`)
        setActivePoint(null)
        return
      }
      setActivePoint(point)
      setPayloadDraft(formatJson(point.payload ?? {}))
    } catch (e) {
      toast.error(formatQdrantError(e))
    }
  }

  const applyPayloadQuery = async () => {
    if (!selected) return
    const filter = buildScrollFilter(queryRows)
    setSearchMode('browse')
    await loadCollection(selected, { filter })
    toast.success(filter ? '已按条件查询' : '已显示全部数据')
  }

  const clearPayloadQuery = async () => {
    if (!selected) return
    setQueryRows([newQueryRow()])
    setSearchMode('browse')
    await loadCollection(selected, { filter: null })
    toast.info('已清除查询条件')
  }

  const runVectorSearch = async () => {
    if (!selected) return
    try {
      const vector = parseVectorInput(vectorQuery)
      setPointsLoading(true)
      setSearchMode('vector')
      setActivePoint(null)
      setPageIndex(0)
      setOffsetStack([null])
      setNextOffset(null)
      const filter = buildScrollFilter(queryRows)
      setActiveFilter(filter)
      const rows = await searchPoints(client, selected, {
        vector,
        limit: PAGE_SIZE,
        withVector,
        filter,
      })
      setPoints(rows)
      toast.success(`向量检索完成，返回 ${rows.length} 条`)
    } catch (e) {
      toast.error(formatQdrantError(e))
    } finally {
      setPointsLoading(false)
    }
  }

  const savePointPayload = async () => {
    if (!selected || !activePoint || pointBusy) return
    setPointBusy(true)
    try {
      const parsed = JSON.parse(payloadDraft) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Payload 必须是 JSON 对象')
      }
      const payload = parsed as Record<string, unknown>
      await overwritePointPayload(client, selected, activePoint.id, payload)
      const updated = { ...activePoint, payload }
      setActivePoint(updated)
      setPoints((prev) =>
        prev.map((p) => (String(p.id) === String(updated.id) ? { ...p, payload } : p)),
      )
      toast.success('Payload 已保存')
    } catch (e) {
      toast.error(formatQdrantError(e))
    } finally {
      setPointBusy(false)
    }
  }

  const refreshIndexes = async () => {
    if (!selected) return
    try {
      const info = await getCollection(client, selected)
      setDetail(info)
    } catch (e) {
      toast.error(formatQdrantError(e))
    }
  }

  const submitCreateIndex = async () => {
    if (!selected || indexBusy) return
    setIndexBusy(true)
    try {
      await createPayloadIndex(client, selected, indexField, indexType)
      toast.success(`已创建索引：${indexField.trim()} (${indexType})`)
      setIndexField('')
      await refreshIndexes()
    } catch (e) {
      toast.error(formatQdrantError(e))
    } finally {
      setIndexBusy(false)
    }
  }

  const removeIndex = async (field: string) => {
    if (!selected || indexBusy) return
    const ok = await dialog.confirm({
      title: '删除索引',
      message: `确认删除字段「${field}」上的 payload 索引？\n不会删除点数据，仅移除索引。`,
      confirmLabel: '删除索引',
      danger: true,
    })
    if (!ok) return
    setIndexBusy(true)
    try {
      await deletePayloadIndex(client, selected, field)
      toast.success(`已删除索引：${field}`)
      await refreshIndexes()
    } catch (e) {
      toast.error(formatQdrantError(e))
    } finally {
      setIndexBusy(false)
    }
  }

  const deleteActivePoint = async () => {
    if (!selected || !activePoint || pointBusy) return
    const ok = await dialog.confirm({
      title: '删除点',
      message: `确认删除点 #${String(activePoint.id)}？此操作不可恢复。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    setPointBusy(true)
    try {
      await deletePoints(client, selected, [activePoint.id])
      setActivePoint(null)
      toast.success('点已删除')
      await loadCollection(selected, { filter: activeFilter })
    } catch (e) {
      toast.error(formatQdrantError(e))
    } finally {
      setPointBusy(false)
    }
  }

  const runExport = async (names: string[]) => {
    if (!connected || names.length === 0 || ioBusy) return
    setIoBusy(true)
    toast.loading('准备导出…', IO_TOAST)
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename =
        names.length === 1
          ? `qdrant-${names[0]}-${stamp}.json`
          : `qdrant-all-${stamp}.json`
      // 流式写出，避免大库 JSON.stringify 报「长度太长」
      const result = await exportCollectionsStreaming(
        client,
        names,
        filename,
        reportProgress,
      )
      toast.success(
        `导出完成：${result.collections} 个库，共 ${result.points.toLocaleString()} 点 · ${formatBytes(result.bytes)} → ${filename}`,
        { id: IO_TOAST },
      )
    } catch (e) {
      toast.error(formatQdrantError(e), { id: IO_TOAST })
    } finally {
      setIoBusy(false)
    }
  }

  const openCreateModal = () => {
    setCreateName('')
    setCreateSize('512')
    setCreateDistance('Cosine')
    setCreateOnDisk(true)
    setCreateOpen(true)
  }

  const submitCreate = async () => {
    if (!connected || createBusy) return
    setCreateBusy(true)
    try {
      const size = Number(createSize)
      await createCollection(client, {
        name: createName,
        size,
        distance: createDistance,
        onDisk: createOnDisk,
      })
      const name = createName.trim()
      setCreateOpen(false)
      toast.success(`已创建 collection：${name}`)
      const cols = await listCollections(client)
      setCollections(cols)
      await loadCollection(name, { resetQuery: true, filter: null })
    } catch (e) {
      toast.error(formatQdrantError(e))
    } finally {
      setCreateBusy(false)
    }
  }

  const prepareImport = async (file: File) => {
    if (!connected || ioBusy) return
    try {
      toast.loading(
        file.size > IMPORT_STREAM_THRESHOLD
          ? `正在检查大文件（${formatBytes(file.size)}）…`
          : '正在读取导入文件…',
        IO_TOAST,
      )
      const plan = await inspectImportFile(file)
      toast.dismiss(IO_TOAST)
      setPendingImport({ ...plan, file })
    } catch (e) {
      toast.error(formatQdrantError(e), { id: IO_TOAST })
    } finally {
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const confirmImport = async (clearPoints: boolean) => {
    if (!pendingImport || ioBusy) return
    const { fileName, file, stream, parsed } = pendingImport
    setPendingImport(null)
    setIoBusy(true)
    toast.loading(
      clearPoints
        ? `清空点后导入：${fileName}`
        : `合并导入（保留现有数据）：${fileName}`,
      IO_TOAST,
    )
    try {
      const results = stream || !parsed
        ? await importExportFileStreaming(
            client,
            file,
            { clearPoints },
            reportProgress,
          )
        : await importCollections(
            client,
            parsed,
            { clearPoints },
            reportProgress,
          )
      const total = results.reduce((n, r) => n + r.points, 0)
      const reopen =
        selected && results.some((r) => r.name === selected)
          ? selected
          : (results[0]?.name ?? null)
      toast.success(
        `导入完成（${clearPoints ? '已清空原有点后写入' : '已合并，未清空原有数据'}）：` +
          `${results.map((r) => `${r.name}(${r.points})`).join('、')}，共 ${total} 个点`,
        { id: IO_TOAST },
      )
      // 软刷新：勿走 connect()，避免 Qdrant 刚忙完时探活失败被打成「未连接」
      try {
        const cols = await listCollections(client)
        setCollections(cols)
        setConnected(true)
        void loadStorageInfo()
        if (reopen && cols.some((c) => c.name === reopen)) {
          await loadCollection(reopen, { resetQuery: true, filter: null })
        }
      } catch {
        toast.info('导入已完成，列表刷新失败，请手动点「刷新」', { id: IO_TOAST })
      }
    } catch (e) {
      toast.error(formatQdrantError(e), { id: IO_TOAST })
      // 部分点可能已写入，尝试刷新状态，但失败时不要强制 setConnected(false)
      try {
        const cols = await listCollections(client)
        setCollections(cols)
        setConnected(true)
        if (selected) await loadCollection(selected)
      } catch {
        // 保持当前 UI，用户可手动重连
      }
    } finally {
      setIoBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>Qdrant Viewer</h1>
            <p className="brand-sub">本地向量库浏览 · 导入导出</p>
          </div>
        </div>

        <form
          className="connect"
          onSubmit={(e) => {
            e.preventDefault()
            void connect(urlDraft.trim() || DEFAULT_QDRANT_URL)
          }}
        >
          <label className="field">
            <span>服务地址</span>
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="/qdrant 或 http://127.0.0.1:6333"
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? '连接中…' : '连接'}
          </button>
        </form>

        <div className={`status ${connected ? 'ok' : 'bad'}`}>
          <span className="dot" />
          {connected ? `已连接 · ${version}` : '未连接'}
        </div>
      </header>

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void prepareImport(file)
        }}
      />

      <div className="layout">
        <aside className="sidebar">
          <div className="panel-head">
            <h2>Collections</h2>
            <button
              type="button"
              className="ghost"
              disabled={!connected || loading || ioBusy}
              onClick={() => void connect(url)}
            >
              刷新
            </button>
          </div>

          <div className="io-actions">
            <button
              type="button"
              disabled={!connected || ioBusy || createBusy}
              onClick={openCreateModal}
            >
              新建
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!connected || ioBusy || collections.length === 0}
              onClick={() => void runExport(collections.map((c) => c.name))}
            >
              导出全部
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!connected || ioBusy}
              onClick={() => importInputRef.current?.click()}
            >
              导入 JSON
            </button>
          </div>

          {!connected && <p className="empty">先连接到本地 Qdrant（默认 6333）</p>}

          {connected && collections.length === 0 && (
            <p className="empty">还没有 collection，点上方「新建」创建一个。</p>
          )}

          <ul className="collection-list">
            {sortedCollections.map((c) => {
              const pinned = pinnedCollections.includes(c.name)
              return (
                <li key={c.name} className="collection-item">
                  <button
                    type="button"
                    className={`pin-btn ${pinned ? 'pinned' : ''}`}
                    title={pinned ? '取消置顶' : '置顶'}
                    aria-label={pinned ? `取消置顶 ${c.name}` : `置顶 ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      togglePinCollection(c.name)
                    }}
                  >
                    {pinned ? '★' : '☆'}
                  </button>
                  <button
                    type="button"
                    className={`collection-btn ${selected === c.name ? 'active' : ''}`}
                    onClick={() =>
                      void loadCollection(c.name, { resetQuery: true, filter: null })
                    }
                  >
                    <span className="name">{c.name}</span>
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="storage-panel">
            <div className="panel-head">
              <h2>数据目录</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => void loadStorageInfo()}
              >
                刷新
              </button>
            </div>
            {storageInfo ? (
              <>
                <p className={`storage-path ${storageInfo.exists ? '' : 'missing'}`}>
                  {storageInfo.path}
                </p>
                <p className="storage-meta">
                  来源：{storageInfo.source}
                  {storageInfo.exists ? ' · 已找到' : ' · 路径不存在'}
                </p>
                {storageInfo.exists && (
                  <p className="storage-size">
                    磁盘占用：<strong>{formatBytes(storageInfo.totalBytes)}</strong>
                  </p>
                )}
                {storageInfo.collectionSizes && storageInfo.collectionSizes.length > 0 && (
                  <ul className="storage-sizes">
                    {storageInfo.collectionSizes.map((c) => (
                      <li key={c.name}>
                        <span className="size-name" title={c.name}>
                          {c.name}
                        </span>
                        <span className="size-val">{formatBytes(c.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {storageInfo.note && <p className="storage-meta">{storageInfo.note}</p>}
                <button
                  type="button"
                  className="ghost storage-copy"
                  onClick={() => copyText(storageInfo.path, '路径已复制')}
                >
                  复制路径
                </button>
              </>
            ) : (
              <p className="empty">
                未能读取本地存储路径。服务器请设置 QDRANT_STORAGE_PATH 后重启。
              </p>
            )}
          </div>
        </aside>

        <main className="main">
          {!selected && (
            <div className="hero-empty">
              <h2>选择一个 collection</h2>
              <p>左侧列表点击后即可查看元信息与 points 数据。</p>
            </div>
          )}

          {selected && detail && (
            <>
              <section className="meta">
                <div className="meta-title">
                  <h2>{detail.name}</h2>
                  <span className="pill">{detail.status}</span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={ioBusy}
                    onClick={() => void runExport([detail.name])}
                  >
                    导出此库
                  </button>
                </div>
                <div className="stats">
                  <div className="stat">
                    <span className="label">Points</span>
                    <span className="value">{detail.pointsCount.toLocaleString()}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Segments</span>
                    <span className="value">{detail.segmentsCount}</span>
                  </div>
                  <div className="stat">
                    <span className="label">磁盘占用</span>
                    <span className="value">
                      {formatBytes(
                        storageInfo?.collectionSizes?.find((c) => c.name === detail.name)
                          ?.bytes,
                      )}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="label">Payload 索引</span>
                    <span className="value">{detail.indexes.length}</span>
                  </div>
                  {detail.indexedVectorsCount !== undefined && (
                    <div className="stat">
                      <span className="label">Indexed Vectors</span>
                      <span className="value">
                        {detail.indexedVectorsCount.toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
                <details className="vectors-config">
                  <summary>向量配置</summary>
                  <pre>{formatJson(detail.vectors)}</pre>
                </details>
              </section>

              <div className="tabs">
                <button
                  type="button"
                  className={`tab ${mainTab === 'points' ? 'active' : ''}`}
                  onClick={() => setMainTab('points')}
                >
                  Points
                </button>
                <button
                  type="button"
                  className={`tab ${mainTab === 'indexes' ? 'active' : ''}`}
                  onClick={() => setMainTab('indexes')}
                >
                  索引 ({detail.indexes.length})
                </button>
              </div>

              {mainTab === 'indexes' && (
                <section className="points indexes-panel">
                  <div className="panel-head">
                    <h2>Payload 索引</h2>
                    <button
                      type="button"
                      className="ghost"
                      disabled={indexBusy}
                      onClick={() => void refreshIndexes()}
                    >
                      刷新索引
                    </button>
                  </div>

                  <form
                    className="index-form"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void submitCreateIndex()
                    }}
                  >
                    <label className="field">
                      <span>字段名</span>
                      <input
                        value={indexField}
                        onChange={(e) => setIndexField(e.target.value)}
                        placeholder="例如 code / assetId / isOnline"
                        spellCheck={false}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>类型</span>
                      <select
                        value={indexType}
                        onChange={(e) =>
                          setIndexType(e.target.value as PayloadSchemaType)
                        }
                      >
                        <option value="keyword">keyword（字符串精确匹配）</option>
                        <option value="text">text（全文）</option>
                        <option value="integer">integer</option>
                        <option value="float">float</option>
                        <option value="bool">bool</option>
                        <option value="datetime">datetime</option>
                        <option value="uuid">uuid</option>
                        <option value="geo">geo</option>
                      </select>
                    </label>
                    <button type="submit" disabled={indexBusy || !indexField.trim()}>
                      {indexBusy ? '处理中…' : '创建索引'}
                    </button>
                  </form>

                  <p className="import-hint">
                    对常用来过滤的字段建索引（如 code、isOnline）可加快条件查询。类型需与字段实际数据类型匹配。
                  </p>

                  <div className="table-wrap">
                    {detail.indexes.length === 0 ? (
                      <p className="empty">还没有 payload 索引。</p>
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>字段</th>
                            <th>类型</th>
                            <th>已索引点数</th>
                            <th>参数</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {detail.indexes.map((idx) => (
                            <tr key={idx.field} className="no-hover">
                              <td className="mono">{idx.field}</td>
                              <td>
                                <span className="pill soft">{idx.dataType}</span>
                              </td>
                              <td className="mono">{idx.points.toLocaleString()}</td>
                              <td className="payload">
                                {idx.params ? formatJson(idx.params) : '—'}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="danger"
                                  disabled={indexBusy}
                                  onClick={() => void removeIndex(idx.field)}
                                >
                                  删除
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </section>
              )}

              {mainTab === 'points' && (
              <section className="points">
                <div className="panel-head">
                  <h2>Points</h2>
                  <div className="toolbar">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={withVector}
                        onChange={(e) => setWithVector(e.target.checked)}
                      />
                      列表带向量
                    </label>
                    <button type="button" className="ghost" onClick={refreshPoints}>
                      重新加载
                    </button>
                    <form
                      className="lookup"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void lookupPoint()
                      }}
                    >
                      <input
                        value={lookupId}
                        onChange={(e) => setLookupId(e.target.value)}
                        placeholder="按 ID 查找"
                        spellCheck={false}
                      />
                      <button type="submit">打开</button>
                    </form>
                  </div>
                </div>

                <div className="query-box">
                  <div className="query-head">
                    <h3>条件查询</h3>
                    {(activeFilter || searchMode === 'vector') && (
                      <span className="pill soft">
                        {searchMode === 'vector' ? '向量检索' : '已应用过滤'}
                      </span>
                    )}
                  </div>
                  <div className="query-rows">
                    {queryRows.map((row) => (
                      <div className="query-row" key={row.id}>
                        <input
                          value={row.key}
                          onChange={(e) =>
                            setQueryRows((prev) =>
                              prev.map((r) =>
                                r.id === row.id ? { ...r, key: e.target.value } : r,
                              ),
                            )
                          }
                          placeholder="字段，如 code"
                          spellCheck={false}
                        />
                        <input
                          value={row.value}
                          onChange={(e) =>
                            setQueryRows((prev) =>
                              prev.map((r) =>
                                r.id === row.id ? { ...r, value: e.target.value } : r,
                              ),
                            )
                          }
                          placeholder="值，如 JRD163ZWIJ / true"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="ghost"
                          disabled={queryRows.length <= 1}
                          onClick={() =>
                            setQueryRows((prev) => prev.filter((r) => r.id !== row.id))
                          }
                        >
                          删
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="query-actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setQueryRows((prev) => [...prev, newQueryRow()])}
                    >
                      加条件
                    </button>
                    <button type="button" onClick={() => void applyPayloadQuery()}>
                      查询
                    </button>
                    <button type="button" className="ghost" onClick={() => void clearPayloadQuery()}>
                      清除
                    </button>
                  </div>
                  <details className="vector-search">
                    <summary>向量相似度检索（可选）</summary>
                    <textarea
                      value={vectorQuery}
                      onChange={(e) => setVectorQuery(e.target.value)}
                      placeholder="粘贴向量 JSON，例如 [0.1, 0.2, ...]"
                      spellCheck={false}
                      rows={4}
                    />
                    <button type="button" onClick={() => void runVectorSearch()}>
                      向量检索
                    </button>
                  </details>
                </div>

                <div className="table-wrap">
                  {pointsLoading ? (
                    <p className="empty">加载 points…</p>
                  ) : points.length === 0 ? (
                    <p className="empty">
                      {activeFilter || searchMode === 'vector'
                        ? '没有符合条件的点。'
                        : '这个 collection 里没有点。'}
                    </p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Payload</th>
                          {searchMode === 'vector' && <th>Score</th>}
                          <th>Vector</th>
                        </tr>
                      </thead>
                      <tbody>
                        {points.map((p) => (
                          <tr
                            key={String(p.id)}
                            className={
                              activePoint && String(activePoint.id) === String(p.id)
                                ? 'selected'
                                : ''
                            }
                            onClick={() => void openPoint(p)}
                          >
                            <td className="id-cell">
                              <span className="mono">{String(p.id)}</span>
                              <button
                                type="button"
                                className="ghost copy-btn"
                                title="复制 ID"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  copyText(String(p.id), 'ID 已复制')
                                }}
                              >
                                复制
                              </button>
                            </td>
                            <td className="payload">{payloadPreview(p.payload)}</td>
                            {searchMode === 'vector' && (
                              <td className="mono dim">
                                {p.score === undefined ? '—' : p.score.toFixed(4)}
                              </td>
                            )}
                            <td className="mono dim">{vectorSummary(p.vector)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="pager">
                  <button
                    type="button"
                    disabled={
                      searchMode === 'vector' || pageIndex <= 0 || pointsLoading
                    }
                    onClick={goPrev}
                  >
                    上一页
                  </button>
                  <span className="page-info">
                    {searchMode === 'vector'
                      ? `向量检索结果 · 最多 ${PAGE_SIZE} 条`
                      : `第 ${pageIndex + 1} 页 · 每页 ${PAGE_SIZE} 条`}
                  </span>
                  <button
                    type="button"
                    disabled={
                      searchMode === 'vector' || nextOffset == null || pointsLoading
                    }
                    onClick={goNext}
                  >
                    下一页
                  </button>
                </div>
              </section>
              )}
            </>
          )}
        </main>
      </div>

      {activePoint && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => !pointBusy && setActivePoint(null)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="point-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2 id="point-modal-title">
                点详情{' '}
                <button
                  type="button"
                  className="id-chip"
                  title="点击复制 ID"
                  onClick={() => copyText(String(activePoint.id), 'ID 已复制')}
                >
                  <span className="mono">#{String(activePoint.id)}</span>
                </button>
              </h2>
              <div className="modal-head-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={pointBusy}
                  onClick={() => copyText(String(activePoint.id), 'ID 已复制')}
                >
                  复制 ID
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={pointBusy}
                  onClick={() => void deleteActivePoint()}
                >
                  删除
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={pointBusy}
                  onClick={() => setActivePoint(null)}
                  aria-label="关闭"
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="modal-body">
              <div>
                <div className="edit-head">
                  <h3>Payload（可编辑）</h3>
                  <button
                    type="button"
                    disabled={pointBusy}
                    onClick={() => void savePointPayload()}
                  >
                    {pointBusy ? '保存中…' : '保存修改'}
                  </button>
                </div>
                <textarea
                  className="payload-editor"
                  value={payloadDraft}
                  onChange={(e) => setPayloadDraft(e.target.value)}
                  spellCheck={false}
                  rows={12}
                />
                <details className="payload-preview-details">
                  <summary>表格预览</summary>
                  <PayloadTable
                    payload={(() => {
                      try {
                        const v = JSON.parse(payloadDraft) as unknown
                        return v && typeof v === 'object' && !Array.isArray(v)
                          ? (v as Record<string, unknown>)
                          : null
                      } catch {
                        return null
                      }
                    })()}
                  />
                </details>
              </div>
              <div>
                <h3>Vector {vectorSummary(activePoint.vector)}</h3>
                <pre className="vector-pre">{formatJson(activePoint.vector)}</pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => !createBusy && setCreateOpen(false)}
        >
          <div
            className="modal modal-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2 id="create-modal-title">新建 Collection</h2>
              <button
                type="button"
                className="ghost"
                disabled={createBusy}
                onClick={() => setCreateOpen(false)}
              >
                取消
              </button>
            </div>
            <form
              className="modal-body create-form"
              onSubmit={(e) => {
                e.preventDefault()
                void submitCreate()
              }}
            >
              <label className="field">
                <span>名称</span>
                <input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="例如 gallery_assets"
                  spellCheck={false}
                  autoFocus
                  required
                />
              </label>
              <label className="field">
                <span>向量维度</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={createSize}
                  onChange={(e) => setCreateSize(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>距离度量</span>
                <select
                  value={createDistance}
                  onChange={(e) => setCreateDistance(e.target.value as Distance)}
                >
                  <option value="Cosine">Cosine</option>
                  <option value="Euclid">Euclid</option>
                  <option value="Dot">Dot</option>
                  <option value="Manhattan">Manhattan</option>
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={createOnDisk}
                  onChange={(e) => setCreateOnDisk(e.target.checked)}
                />
                查询时从磁盘读向量（on_disk，更省内存）
              </label>
              <p className="import-hint">
                数据本身始终会持久化到 Qdrant 磁盘目录，关机不会丢。上面的选项只决定查询时向量是否常驻
                RAM。名称仅支持字母、数字、下划线和短横线。
              </p>
              <div className="import-actions">
                <button type="submit" disabled={createBusy || !createName.trim()}>
                  {createBusy ? '创建中…' : '创建'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {pendingImport && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => !ioBusy && setPendingImport(null)}
        >
          <div
            className="modal modal-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2 id="import-modal-title">选择导入方式</h2>
              <button
                type="button"
                className="ghost"
                disabled={ioBusy}
                onClick={() => setPendingImport(null)}
              >
                取消
              </button>
            </div>
            <div className="modal-body">
              <p className="import-summary">
                文件 <span className="mono">{pendingImport.fileName}</span>
                （{formatBytes(pendingImport.fileSize)}）
                {pendingImport.stream
                  ? '，大文件将流式导入'
                  : `，共 ${pendingImport.preview.length} 个 collection、${pendingImport.preview.reduce((n, c) => n + (c.points ?? 0), 0)} 个点`}
                。
              </p>
              <ul className="import-list">
                {pendingImport.preview.map((c) => (
                  <li key={c.name}>
                    <span className="mono">{c.name}</span>
                    <span className="dim">
                      {c.points == null ? '点数导入时统计' : `${c.points} 点`}
                    </span>
                  </li>
                ))}
              </ul>
              {pendingImport.stream && (
                <p className="import-hint">
                  文件较大，不会整包解析 JSON，而是边读边写入，避免「无效格式 / 字符串过长」。
                </p>
              )}
              <p className="import-hint">
                「合并导入」只覆盖同 ID 的点；「清空点后导入」会删光该库里的点再写入，但不会删除
                collection 本身（避免 Windows 删目录报拒绝访问）。
              </p>
              <div className="import-actions">
                <button type="button" disabled={ioBusy} onClick={() => void confirmImport(false)}>
                  合并导入（推荐）
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={ioBusy}
                  onClick={() => {
                    const names = pendingImport.preview.map((c) => c.name).join('、')
                    void dialog
                      .confirm({
                        title: '确认清空点后导入',
                        message:
                          `将清空以下 collection 里的全部点后再写入：\n${names}\n\n` +
                          '不会删除 collection 结构，此操作不可恢复。',
                        confirmLabel: '清空并导入',
                        cancelLabel: '返回',
                        danger: true,
                      })
                      .then((ok) => {
                        if (ok) void confirmImport(true)
                      })
                  }}
                >
                  清空点后导入
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
