import {
  fileCatalog,
  icebergAppend,
  icebergCreateTable,
  icebergDelete,
  icebergDropTable,
  icebergManifests,
  icebergRead,
  icebergRewrite,
  loadLatestFileCatalogMetadata,
} from 'icebird'
import type { FileCatalog, TableMetadata } from 'icebird/src/types.js'
import { fetchSnapshotBundle, type MetadataBundle } from './metadata.js'
import { formatRow, isoToDays } from './json.js'
import { MemoryObjectStore } from './memoryStore.js'
import { resolveVisibleRows, type RowRef } from './rowLocations.js'

export type { RowRef }

const TABLE_URL = 'memory://warehouse/demo/events'

const SCHEMA = {
  type: 'struct' as const,
  'schema-id': 0,
  fields: [
    { id: 1, name: 'date', required: true, type: 'date' as const },
    { id: 2, name: 'state', required: true, type: 'string' as const },
    { id: 3, name: 'value', required: true, type: 'string' as const },
  ],
}

const PARTITION_SPEC = {
  'spec-id': 0,
  fields: [
    {
      'source-id': 1,
      'field-id': 1001,
      name: 'date_month',
      transform: 'month' as const,
    },
    {
      'source-id': 2,
      'field-id': 1002,
      name: 'state_bucket_10',
      transform: 'bucket[10]' as const,
    },
  ],
}

export type SnapshotSummary = {
  index: number
  snapshot_id: string | null
  label: string
  action: string
  timestamp: string
  row_count: number
  metadata_file: string
  manifest_list_path: string | null
  manifest_count: number
}

type HistoryEntry = {
  label: string
  action: string
  timestamp: string
  rowCount: number
  metadata: TableMetadata
  metadataLocation: string
  bundle: MetadataBundle
}

export class IcebergExplainer {
  private readonly store = new MemoryObjectStore()
  private catalog: FileCatalog
  private history: HistoryEntry[] = []

  constructor() {
    this.catalog = fileCatalog({
      resolver: this.store.resolver(),
      lister: this.store.lister(),
    })
  }

  async init(): Promise<void> {
    await this.reset()
  }

  private async capture(label: string, action: string): Promise<number> {
    const { metadata, metadataLocation } = await loadLatestFileCatalogMetadata({
      tableUrl: TABLE_URL,
      resolver: this.store.resolver(),
      lister: this.store.lister(),
    })

    let rows: Record<string, unknown>[] = []
    if (metadata['current-snapshot-id'] != null) {
      rows = await icebergRead({
        tableUrl: TABLE_URL,
        metadata,
        resolver: this.store.resolver(),
        lister: this.store.lister(),
      })
    }

    let bundle: MetadataBundle
    if (metadata['current-snapshot-id'] != null) {
      bundle = await fetchSnapshotBundle(
        metadata,
        metadataLocation,
        this.store.resolver(),
      )
    } else {
      bundle = {
        metadata_location: metadataLocation,
        metadata,
        current_snapshot_id: null,
        manifest_list_path: null,
        manifest_list: [],
        manifests: [],
      }
    }

    this.history.push({
      label,
      action,
      timestamp: new Date().toISOString(),
      rowCount: rows.length,
      metadata,
      metadataLocation,
      bundle,
    })
    return this.history.length - 1
  }

  async reset(): Promise<number> {
    this.history = []
    this.store.clear()
    this.catalog = fileCatalog({
      resolver: this.store.resolver(),
      lister: this.store.lister(),
    })
    try {
      await icebergDropTable({
        catalog: this.catalog,
        tableUrl: TABLE_URL,
        lister: this.store.lister(),
        purgeRequested: true,
      })
    } catch {
      /* first run */
    }
    await icebergCreateTable({
      catalog: this.catalog,
      tableUrl: TABLE_URL,
      schema: SCHEMA,
      partitionSpec: PARTITION_SPEC,
      formatVersion: 2,
      properties: {
        'write.delete.mode': 'merge-on-read',
      },
    })
    return this.capture('Empty table created', 'reset')
  }

  async addRow(date: string, state: string, value: string): Promise<number> {
    await icebergAppend({
      catalog: this.catalog,
      tableUrl: TABLE_URL,
      records: [{ date: isoToDays(date), state, value }],
    })
    return this.capture(`Added row: ${date} / ${state} / ${value}`, 'append')
  }

  async deleteRow(logicalIndex: number): Promise<number> {
    const { metadata } = await loadLatestFileCatalogMetadata({
      tableUrl: TABLE_URL,
      resolver: this.store.resolver(),
      lister: this.store.lister(),
    })
    const refs = await resolveVisibleRows(metadata, this.store)
    const target = refs[logicalIndex]
    if (!target) {
      throw new Error(`Row index ${logicalIndex} out of range`)
    }

    await icebergDelete({
      catalog: this.catalog,
      tableUrl: TABLE_URL,
      resolver: this.store.resolver(),
      deletes: [{ file_path: target.file_path, pos: target.pos }],
    })
    return this.capture(
      `Deleted row at pos ${target.pos} in ${target.file_path.split('/').pop()}: ${target.date} / ${target.state} / ${target.value}`,
      'delete',
    )
  }

  async getVisibleRows(): Promise<RowRef[]> {
    if (this.history.length === 0) return []
    const entry = this.history[this.history.length - 1]
    if (entry.metadata['current-snapshot-id'] == null) return []
    const refs = await resolveVisibleRows(entry.metadata, this.store)
    return refs.map((row, index) => ({ index, ...row }))
  }

  async compact(): Promise<number> {
    const { metadata } = await loadLatestFileCatalogMetadata({
      tableUrl: TABLE_URL,
      resolver: this.store.resolver(),
      lister: this.store.lister(),
    })
    const rows = await icebergRead({
      tableUrl: TABLE_URL,
      metadata,
      resolver: this.store.resolver(),
      lister: this.store.lister(),
    })
    if (rows.length === 0) {
      return this.capture('Compact (no-op): table is empty', 'compact')
    }

    const manifests = await icebergManifests({
      metadata,
      resolver: this.store.resolver(),
    })
    const fileCounts = new Map<string, number>()
    for (const { entries } of manifests) {
      for (const entry of entries) {
        if (entry.status === 2 || entry.data_file.content !== 0) continue
        const key = JSON.stringify(entry.data_file.partition)
        fileCounts.set(key, (fileCounts.get(key) ?? 0) + 1)
      }
    }
    const needsCompact = [...fileCounts.values()].some((n) => n > 1)
    if (!needsCompact) {
      return this.capture(
        'Compact (no-op): every partition already has one data file',
        'compact',
      )
    }

    await icebergRewrite({ catalog: this.catalog, tableUrl: TABLE_URL })
    const parts = [...fileCounts.entries()]
      .filter(([, n]) => n > 1)
      .map(([p, n]) => `${p} (${n} files → 1)`)
    return this.capture(`Compacted: ${parts.join(', ')}`, 'compact')
  }

  async getRows(): Promise<Array<Record<string, string>>> {
    if (this.history.length === 0) return []
    const entry = this.history[this.history.length - 1]
    const rows = await icebergRead({
      tableUrl: TABLE_URL,
      metadata: entry.metadata,
      resolver: this.store.resolver(),
      lister: this.store.lister(),
    })
    return rows.map((r) => formatRow(r))
  }

  getPartitions(): Array<Record<string, unknown>> {
    if (this.history.length === 0) return []
    const entry = this.history[this.history.length - 1]
    const counts = new Map<
      string,
      { date_month: unknown; state_bucket_10: unknown; record_count: number; file_count: number }
    >()
    for (const manifest of entry.bundle.manifests) {
      for (const raw of manifest.entries) {
        const e = raw as { status: number; data_file: Record<string, unknown> }
        if (e.status === 2) continue
        const df = e.data_file
        if ((df.content as number) !== 0) continue
        const part = df.partition as Record<string, unknown>
        const key = JSON.stringify(part)
        const cur = counts.get(key) ?? {
          date_month: part.date_month,
          state_bucket_10: part.state_bucket_10,
          record_count: 0,
          file_count: 0,
        }
        cur.record_count += Number(df.record_count ?? 0)
        cur.file_count += 1
        counts.set(key, cur)
      }
    }
    return [...counts.values()].map((p) => ({
      ...p,
      needs_compaction: p.file_count > 1,
    }))
  }

  listSnapshots(): SnapshotSummary[] {
    return this.history.map((h, index) => ({
      index,
      snapshot_id: h.bundle.current_snapshot_id != null ? String(h.bundle.current_snapshot_id) : null,
      label: h.label,
      action: h.action,
      timestamp: h.timestamp,
      row_count: h.rowCount,
      metadata_file: h.metadataLocation,
      manifest_list_path: h.bundle.manifest_list_path,
      manifest_count: h.bundle.manifests.length,
    }))
  }

  getSnapshot(index: number): MetadataBundle & HistoryEntry & { index: number } {
    const entry = this.history[index]
    if (!entry) throw new Error(`Snapshot index ${index} out of range`)
    return { index, ...entry, ...entry.bundle }
  }

  getStore(): MemoryObjectStore {
    return this.store
  }
}

