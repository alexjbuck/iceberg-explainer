import { fetchDeleteMaps } from 'icebird/src/fetch.js'
import { deleteFileAppliesToDataEntry } from 'icebird/src/delete.js'
import { splitManifestEntries } from 'icebird/src/manifest.js'
import { icebergManifests } from 'icebird'
import { parquetReadObjects } from 'hyparquet'
import type { Resolver, TableMetadata } from 'icebird/src/types.js'
import { formatRow } from './json.js'
import type { MemoryObjectStore } from './memoryStore.js'

export type RowRef = {
  index: number
  date: string
  state: string
  value: string
  file_path: string
  pos: number
}

const MANIFEST_DELETED = 2

export async function resolveVisibleRows(
  metadata: TableMetadata,
  store: MemoryObjectStore,
): Promise<Omit<RowRef, 'index'>[]> {
  const resolver = store.resolver()
  const manifestList = await icebergManifests({ metadata, resolver })
  const { dataEntries, deleteEntries } = splitManifestEntries(manifestList)
  const { positionDeletesMap } = await fetchDeleteMaps(deleteEntries, resolver)

  const visible: Omit<RowRef, 'index'>[] = []

  for (const entry of dataEntries) {
    if (entry.status === MANIFEST_DELETED) continue
    const dataFile = entry.data_file
    if (dataFile.content !== 0) continue

    const path = dataFile.file_path
    const bytes = store.read(path)
    if (!bytes) continue

    const positionDeletes = new Set<number>()
    for (const group of positionDeletesMap.get(path) ?? []) {
      if (!deleteFileAppliesToDataEntry(entry, group.deleteEntry, metadata, 'position')) {
        continue
      }
      for (const pos of group.positions) positionDeletes.add(Number(pos))
    }

    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const rows = await parquetReadObjects({ file: buffer })
    for (let pos = 0; pos < rows.length; pos++) {
      if (positionDeletes.has(pos)) continue
      const formatted = formatRow(rows[pos] as Record<string, unknown>)
      visible.push({
        date: formatted.date,
        state: formatted.state,
        value: formatted.value,
        file_path: path,
        pos,
      })
    }
  }

  return visible
}
