import { fetchAvroRecords } from 'icebird/src/fetch.js'
import type { Resolver, TableMetadata } from 'icebird/src/types.js'
import { icebergManifests } from 'icebird'
import { toJson } from './json.js'

export type MetadataBundle = {
  metadata_location: string
  metadata: TableMetadata
  current_snapshot_id: string | number | null
  manifest_list_path: string | null
  manifest_list: Record<string, unknown>[]
  manifests: Array<{
    path: string
    manifest_list_entry?: Record<string, unknown>
    entries: Record<string, unknown>[]
  }>
}

export async function fetchSnapshotBundle(
  metadata: TableMetadata,
  metadataLocation: string,
  resolver: Resolver,
  snapshotId?: number | bigint,
): Promise<MetadataBundle> {
  const sid = snapshotId ?? metadata['current-snapshot-id'] ?? null
  const snapshot = metadata.snapshots?.find(
    (s) => BigInt(s['snapshot-id']) === BigInt(sid ?? -1),
  )

  let manifestListPath: string | null = null
  let manifestListRecords: Record<string, unknown>[] = []
  let manifests: MetadataBundle['manifests'] = []

  if (snapshot?.['manifest-list']) {
    manifestListPath = snapshot['manifest-list']
    manifestListRecords = (await fetchAvroRecords(
      manifestListPath,
      resolver,
    )) as Record<string, unknown>[]
    const manifestFiles = await icebergManifests({
      metadata,
      resolver,
      snapshotId: sid ?? undefined,
    })
    manifests = manifestFiles.map((mf, i) => ({
      path: mf.url,
      manifest_list_entry: manifestListRecords[i],
      entries: mf.entries as unknown as Record<string, unknown>[],
    }))
  }

  return {
    metadata_location: metadataLocation,
    metadata,
    current_snapshot_id: sid == null ? null : String(sid),
    manifest_list_path: manifestListPath,
    manifest_list: manifestListRecords,
    manifests,
  }
}

export function highlightMetadataChanges(
  before: TableMetadata,
  after: TableMetadata,
): Record<string, unknown> {
  const beforeSnaps = new Map(
    (before.snapshots ?? []).map((s) => [String(s['snapshot-id']), s]),
  )
  const afterSnaps = new Map(
    (after.snapshots ?? []).map((s) => [String(s['snapshot-id']), s]),
  )
  const added = [...afterSnaps.keys()]
    .filter((id) => !beforeSnaps.has(id))
    .map((id) => afterSnaps.get(id))

  return {
    current_snapshot_id: {
      before: before['current-snapshot-id'] ?? null,
      after: after['current-snapshot-id'] ?? null,
    },
    new_snapshots: added,
    snapshot_count: {
      before: beforeSnaps.size,
      after: afterSnaps.size,
    },
    metadata_before: toJson(before),
    metadata_after: toJson(after),
  }
}

export function diffSnapshots(
  before: MetadataBundle,
  after: MetadataBundle,
  fromLabel: string,
  toLabel: string,
  fromIndex: number,
  toIndex: number,
): Record<string, unknown> {
  return {
    from_index: fromIndex,
    to_index: toIndex,
    from_label: fromLabel,
    to_label: toLabel,
    metadata: highlightMetadataChanges(before.metadata, after.metadata),
    manifest_list_diff: {
      before_count: before.manifest_list.length,
      after_count: after.manifest_list.length,
      before: before.manifest_list,
      after: after.manifest_list,
    },
    manifests_before: before.manifests,
    manifests_after: after.manifests,
  }
}
