import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import type { MetadataBundle } from './metadata.js'
import { formatRow, jsonReplacer } from './json.js'
import type { MemoryObjectStore } from './memoryStore.js'

const MANIFEST_DELETED = 2

function decodeIcebergDateBound(value: unknown): unknown {
  if (typeof value === 'string' && value.length === 8 && /^[0-9a-f]+$/.test(value)) {
    const bytes = new Uint8Array(value.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
    const view = new DataView(bytes.buffer)
    const days = view.getInt32(0, true)
    const ms = days * 86400000
    return new Date(ms).toISOString().slice(0, 10)
  }
  return value
}

function icebergManifestStats(dataFile: Record<string, unknown>): Array<Record<string, unknown>> {
  const fieldNames: Record<number, string> = { 1: 'date', 2: 'state', 3: 'value' }
  const lowers = Object.fromEntries(
    ((dataFile.lower_bounds as Array<{ key: number; value: unknown }>) ?? []).map((x) => [
      x.key,
      x.value,
    ]),
  )
  const uppers = Object.fromEntries(
    ((dataFile.upper_bounds as Array<{ key: number; value: unknown }>) ?? []).map((x) => [
      x.key,
      x.value,
    ]),
  )
  const nulls = Object.fromEntries(
    ((dataFile.null_value_counts as Array<{ key: number; value: unknown }>) ?? []).map(
      (x) => [x.key, x.value],
    ),
  )
  const counts = Object.fromEntries(
    ((dataFile.value_counts as Array<{ key: number; value: unknown }>) ?? []).map((x) => [
      x.key,
      x.value,
    ]),
  )
  return Object.entries(fieldNames).map(([id, name]) => ({
    column: name,
    field_id: Number(id),
    lower_bound: decodeIcebergDateBound(lowers[Number(id)]),
    upper_bound: decodeIcebergDateBound(uppers[Number(id)]),
    null_count: nulls[Number(id)],
    value_count: counts[Number(id)],
  }))
}

function parquetRowGroupStats(meta: ReturnType<typeof parquetMetadata>): Array<Record<string, unknown>> {
  return meta.row_groups.map((rg, index) => ({
    index,
    num_rows: String(rg.num_rows),
    total_byte_size: rg.total_byte_size,
    columns: rg.columns.map((col) => {
      const stats = col.meta_data?.statistics
      return {
        column: col.meta_data?.path_in_schema?.join('.') ?? '?',
        physical_type: String(col.meta_data?.type),
        min: stats?.min_value ?? stats?.min ?? null,
        max: stats?.max_value ?? stats?.max ?? null,
        null_count: stats?.null_count != null ? String(stats.null_count) : null,
        num_values: null,
      }
    }),
  }))
}

export async function readParquetFiles(
  bundle: MetadataBundle,
  store: MemoryObjectStore,
): Promise<{ files: Array<Record<string, unknown>>; file_count: number }> {
  const files: Array<Record<string, unknown>> = []

  for (const manifest of bundle.manifests) {
    for (const entry of manifest.entries) {
      if ((entry.status as number) === MANIFEST_DELETED) continue
      const dataFile = entry.data_file as Record<string, unknown> | undefined
      if (!dataFile?.file_path) continue
      const content = dataFile.content as number
      const path = String(dataFile.file_path)
      const bytes = store.read(path)
      if (!bytes) continue

      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
      const meta = parquetMetadata(buffer)

      if (content === 1) {
        const rowsRaw = await parquetReadObjects({ file: buffer })
        const rows = rowsRaw.map((row) => ({
          file_path: String((row as Record<string, unknown>).file_path ?? ''),
          pos: String((row as Record<string, unknown>).pos ?? ''),
        }))
        files.push({
          path,
          file_name: path.split('/').pop(),
          file_type: 'position_delete',
          file_size_bytes: bytes.byteLength,
          num_rows: String(meta.num_rows),
          partition: dataFile.partition,
          columns: ['file_path', 'pos'],
          rows,
          row_groups: parquetRowGroupStats(meta),
          iceberg_manifest_stats: [],
        })
        continue
      }

      if (content !== 0) continue

      const rowsRaw = await parquetReadObjects({ file: buffer })
      const rows = rowsRaw.map((row) => formatRow(row as Record<string, unknown>))

      files.push({
        path,
        file_name: path.split('/').pop(),
        file_type: 'data',
        file_size_bytes: bytes.byteLength,
        num_rows: String(meta.num_rows),
        partition: dataFile.partition,
        columns: ['date', 'state', 'value'],
        rows,
        row_groups: parquetRowGroupStats(meta),
        iceberg_manifest_stats: icebergManifestStats(dataFile),
      })
    }
  }

  return { files, file_count: files.length }
}

export function serializeForDisplay(value: unknown): string {
  return JSON.stringify(value, jsonReplacer, 2)
}
