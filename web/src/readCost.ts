import type { MetadataBundle } from './metadata.js'
import type { MemoryObjectStore } from './memoryStore.js'

const MANIFEST_DELETED = 2
const CONTENT_DATA = 0
const CONTENT_POSITION_DELETE = 1

export type FileRef = {
  path: string
  bytes: number
  kind: 'metadata' | 'manifest-list' | 'manifest' | 'data' | 'delete'
}

export type ReadCostLayer = {
  id: string
  label: string
  description: string
  file_count: number
  bytes: number
  required: 'always' | 'prune'
}

export type ReadCostAnalysis = {
  layers: ReadCostLayer[]
  /** Files every query must read before pruning can begin. */
  fixed_file_count: number
  fixed_bytes: number
  /** Entire metadata layer at this snapshot (for explosion view). */
  metadata_tree_file_count: number
  metadata_tree_bytes: number
  /** SELECT * full table scan at this snapshot. */
  full_scan_file_count: number
  full_scan_bytes: number
  full_scan_manifest_count: number
  full_scan_data_count: number
  full_scan_delete_count: number
  metadata_path: string
  metadata_bytes: number
  manifest_list_path: string | null
  manifest_list_bytes: number
  manifest_files: FileRef[]
  data_files: FileRef[]
  delete_files: FileRef[]
}

function fileBytes(store: MemoryObjectStore, path: string | null | undefined): number {
  if (!path) return 0
  return store.read(path)?.byteLength ?? 0
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function analyzeReadCost(
  snapshot: MetadataBundle,
  store: MemoryObjectStore,
): ReadCostAnalysis {
  const metadataPath = snapshot.metadata_location
  const metadataBytes = fileBytes(store, metadataPath)

  const manifestListPath = snapshot.manifest_list_path
  const manifestListBytes = fileBytes(store, manifestListPath)

  const manifestFiles: FileRef[] = snapshot.manifests.map((m) => ({
    path: m.path,
    bytes: fileBytes(store, m.path),
    kind: 'manifest' as const,
  }))

  const dataPaths = new Map<string, FileRef>()
  const deletePaths = new Map<string, FileRef>()

  for (const manifest of snapshot.manifests) {
    for (const raw of manifest.entries) {
      const e = raw as { status: number; data_file: Record<string, unknown> }
      if (e.status === MANIFEST_DELETED) continue
      const df = e.data_file
      const path = String(df.file_path ?? '')
      if (!path) continue
      const content = df.content as number
      if (content === CONTENT_DATA) {
        if (!dataPaths.has(path)) {
          dataPaths.set(path, {
            path,
            bytes: fileBytes(store, path),
            kind: 'data',
          })
        }
      } else if (content === CONTENT_POSITION_DELETE) {
        if (!deletePaths.has(path)) {
          deletePaths.set(path, {
            path,
            bytes: fileBytes(store, path),
            kind: 'delete',
          })
        }
      }
    }
  }

  const dataFiles = [...dataPaths.values()]
  const deleteFiles = [...deletePaths.values()]

  const manifestBytes = manifestFiles.reduce((n, f) => n + f.bytes, 0)
  const dataBytes = dataFiles.reduce((n, f) => n + f.bytes, 0)
  const deleteBytes = deleteFiles.reduce((n, f) => n + f.bytes, 0)

  const fixedFileCount = (metadataPath ? 1 : 0) + (manifestListPath ? 1 : 0)
  const fixedBytes = metadataBytes + manifestListBytes

  const metadataTreeFileCount =
    fixedFileCount + manifestFiles.length + dataFiles.length + deleteFiles.length
  const metadataTreeBytes =
    fixedBytes + manifestBytes + dataBytes + deleteBytes

  const fullScanManifestCount = manifestFiles.length
  const fullScanDataCount = dataFiles.length
  const fullScanDeleteCount = deleteFiles.length
  const fullScanFileCount =
    fixedFileCount + fullScanManifestCount + fullScanDataCount + fullScanDeleteCount
  const fullScanBytes = fixedBytes + manifestBytes + dataBytes + deleteBytes

  const layers: ReadCostLayer[] = [
    {
      id: 'fixed',
      label: 'Fixed per query',
      description: 'metadata.json + manifest list for the current snapshot',
      file_count: fixedFileCount,
      bytes: fixedBytes,
      required: 'always',
    },
    {
      id: 'manifests',
      label: 'Manifest files',
      description: 'Pruned using manifest-list partition summaries and column bounds',
      file_count: manifestFiles.length,
      bytes: manifestBytes,
      required: 'prune',
    },
    {
      id: 'data',
      label: 'Data files',
      description: 'Pruned using per-file partition values and column stats in manifests',
      file_count: dataFiles.length,
      bytes: dataBytes,
      required: 'prune',
    },
    {
      id: 'deletes',
      label: 'Position delete files',
      description: 'Needed for merge-on-read when selected data files have pending deletes',
      file_count: deleteFiles.length,
      bytes: deleteBytes,
      required: 'prune',
    },
  ]

  return {
    layers,
    fixed_file_count: fixedFileCount,
    fixed_bytes: fixedBytes,
    metadata_tree_file_count: metadataTreeFileCount,
    metadata_tree_bytes: metadataTreeBytes,
    full_scan_file_count: fullScanFileCount,
    full_scan_bytes: fullScanBytes,
    full_scan_manifest_count: fullScanManifestCount,
    full_scan_data_count: fullScanDataCount,
    full_scan_delete_count: fullScanDeleteCount,
    metadata_path: metadataPath,
    metadata_bytes: metadataBytes,
    manifest_list_path: manifestListPath,
    manifest_list_bytes: manifestListBytes,
    manifest_files: manifestFiles,
    data_files: dataFiles,
    delete_files: deleteFiles,
  }
}

export function renderReadPathHtml(
  analysis: ReadCostAnalysis,
  options: { queryLabel: string; snapshotIndex: number },
): string {
  const { queryLabel, snapshotIndex } = options
  const hasData = analysis.metadata_tree_file_count > 0

  if (!hasData || !analysis.manifest_list_path) {
    return `
      <p class="hint">Empty table — a query only needs the catalog pointer and <code>metadata.json</code>
      (${formatBytes(analysis.metadata_bytes)}). No manifest list yet.</p>
      ${renderFlowDiagram(analysis, queryLabel, true)}
    `
  }

  return `
    <p class="hint">
      Snapshot <strong>#${snapshotIndex}</strong> · illustrating reads for
      <code>${escapeHtml(queryLabel)}</code>. Fixed layers are paid on every query; manifest and
      data layers depend on partition/column pruning (counts below assume a full table scan).
    </p>
    ${renderCostSummary(analysis)}
    ${renderExplosionBars(analysis)}
    ${renderFlowDiagram(analysis, queryLabel, false)}
    ${renderFileTable(analysis)}`
}

function renderCostSummary(analysis: ReadCostAnalysis) {
  return `
    <div class="kv-grid read-cost-summary">
      <div><strong>Fixed reads</strong>${analysis.fixed_file_count} file(s) · ${formatBytes(analysis.fixed_bytes)}</div>
      <div><strong>Metadata tree</strong>${analysis.metadata_tree_file_count} file(s) · ${formatBytes(analysis.metadata_tree_bytes)}</div>
      <div><strong>Full scan (SELECT *)</strong>${analysis.full_scan_file_count} file(s) · ${formatBytes(analysis.full_scan_bytes)}</div>
      <div><strong>Pruneable pool</strong>${analysis.manifest_files.length} manifest(s), ${analysis.data_files.length} data, ${analysis.delete_files.length} delete</div>
    </div>`
}

function renderExplosionBars(analysis: ReadCostAnalysis) {
  const total = Math.max(analysis.metadata_tree_bytes, 1)
  const segments = [
    { label: 'metadata.json', bytes: analysis.metadata_bytes, cls: 'bar-fixed' },
    { label: 'manifest list', bytes: analysis.manifest_list_bytes, cls: 'bar-fixed' },
    { label: 'manifests', bytes: analysis.manifest_files.reduce((n, f) => n + f.bytes, 0), cls: 'bar-manifest' },
    { label: 'data files', bytes: analysis.data_files.reduce((n, f) => n + f.bytes, 0), cls: 'bar-data' },
    { label: 'delete files', bytes: analysis.delete_files.reduce((n, f) => n + f.bytes, 0), cls: 'bar-delete' },
  ].filter((s) => s.bytes > 0)

  const bars = segments
    .map(
      (s) =>
        `<div class="read-cost-bar-seg ${s.cls}" style="width:${((s.bytes / total) * 100).toFixed(1)}%" title="${escapeHtml(s.label)}: ${formatBytes(s.bytes)}"></div>`,
    )
    .join('')

  const legend = segments
    .map(
      (s) =>
        `<span class="read-cost-legend-item"><span class="read-cost-legend-swatch ${s.cls}"></span>${escapeHtml(s.label)} · ${formatBytes(s.bytes)}</span>`,
    )
    .join('')

  return `
    <div class="read-cost-bars-wrap">
      <h3>Metadata footprint at this snapshot</h3>
      <p class="hint muted">Fixed layers grow with snapshot history (metadata.json) and table activity; pruneable layers grow with un-compacted writes.</p>
      <div class="read-cost-bars">${bars}</div>
      <div class="read-cost-legend">${legend}</div>
    </div>`
}

function renderFlowDiagram(
  analysis: ReadCostAnalysis,
  queryLabel: string,
  empty: boolean,
) {
  const steps = [
    {
      title: 'Catalog / table metadata',
      detail: 'Resolve table name → pointer to current metadata.json (REST or Hive catalog call)',
      badge: 'catalog RPC',
      badgeClass: 'badge-catalog',
      fixed: false,
    },
    {
      title: 'metadata.json',
      detail: analysis.metadata_path
        ? basename(analysis.metadata_path)
        : '(not written yet)',
      badge: `${formatBytes(analysis.metadata_bytes)} · always read`,
      badgeClass: 'badge-fixed',
      fixed: true,
    },
    {
      title: 'Manifest list (Avro)',
      detail: analysis.manifest_list_path
        ? basename(analysis.manifest_list_path)
        : empty
          ? '(none — empty table)'
          : '(none)',
      badge: analysis.manifest_list_path
        ? `${formatBytes(analysis.manifest_list_bytes)} · always read`
        : 'skipped',
      badgeClass: 'badge-fixed',
      fixed: true,
    },
    {
      title: 'Manifest files',
      detail: empty
        ? 'No manifests yet'
        : `Up to ${analysis.manifest_files.length} file(s) · ${formatBytes(analysis.manifest_files.reduce((n, f) => n + f.bytes, 0))} in table`,
      badge: empty
        ? '0 read'
        : `SELECT *: ${analysis.full_scan_manifest_count} read`,
      badgeClass: 'badge-prune',
      fixed: false,
    },
    {
      title: 'Data + delete files',
      detail: empty
        ? 'No data files yet'
        : `${analysis.data_files.length} data + ${analysis.delete_files.length} position-delete file(s)`,
      badge: empty
        ? '0 read'
        : `SELECT *: ${analysis.full_scan_data_count} data + ${analysis.full_scan_delete_count} delete`,
      badgeClass: 'badge-prune',
      fixed: false,
    },
    {
      title: 'Return rows',
      detail: `Engine applies filters, merge-on-read deletes, and projection for <code>${escapeHtml(queryLabel)}</code>`,
      badge: 'result',
      badgeClass: 'badge-result',
      fixed: false,
    },
  ]

  const stepsHtml = steps
    .map((step, i) => {
      const connector = i > 0 ? '<div class="read-path-connector" aria-hidden="true">↓</div>' : ''
      return `${connector}
        <div class="read-path-step ${step.fixed ? 'read-path-fixed' : 'read-path-prune'}">
          <div class="read-path-step-num">${i + 1}</div>
          <div class="read-path-step-body">
            <strong>${escapeHtml(step.title)}</strong>
            <p>${step.detail.includes('<code>') ? step.detail : escapeHtml(step.detail)}</p>
            <span class="read-path-badge ${step.badgeClass}">${escapeHtml(step.badge)}</span>
          </div>
        </div>`
    })
    .join('')

  return `
    <div class="read-path-flow-wrap">
      <h3>Query read path</h3>
      <div class="read-path-flow">${stepsHtml}</div>
    </div>`
}

function renderFileTable(analysis: ReadCostAnalysis) {
  const rows = [
    ...analysis.manifest_files.map((f) => ({
      layer: 'manifest',
      path: f.path,
      bytes: f.bytes,
    })),
    ...analysis.data_files.map((f) => ({
      layer: 'data',
      path: f.path,
      bytes: f.bytes,
    })),
    ...analysis.delete_files.map((f) => ({
      layer: 'delete',
      path: f.path,
      bytes: f.bytes,
    })),
  ]
  if (!rows.length) return ''

  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.layer)}</td><td class="mono-path">${escapeHtml(basename(r.path))}</td><td>${formatBytes(r.bytes)}</td></tr>`,
    )
    .join('')

  return `
    <details class="read-path-files">
      <summary>Pruneable files at this snapshot (${rows.length})</summary>
      <div class="table-wrap"><table><thead><tr><th>layer</th><th>file</th><th>size</th></tr></thead><tbody>${body}</tbody></table></div>
    </details>`
}

function escapeHtml(text: unknown) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
