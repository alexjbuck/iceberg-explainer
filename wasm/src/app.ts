import { diffSnapshots } from './metadata.js'
import { IcebergExplainer } from './explainer.js'
import { toJson } from './json.js'
import { readParquetFiles } from './parquet.js'
import type { SnapshotSummary } from './explainer.js'

type PartitionInfo = {
  date_month: unknown
  state_bucket_10: unknown
  file_count: number
  needs_compaction: boolean
}

const state = {
  snapshots: [] as SnapshotSummary[],
  currentIndex: 0,
  parquetCache: {} as Record<number, Awaited<ReturnType<typeof readParquetFiles>>>,
}

const els = {
  rowsBody: document.querySelector('#rows-table tbody')!,
  addForm: document.querySelector('#add-row-form') as HTMLFormElement,
  resetBtn: document.querySelector('#reset-btn') as HTMLButtonElement,
  compactBtn: document.querySelector('#compact-btn') as HTMLButtonElement,
  partitionHint: document.querySelector('#partition-hint')!,
  slider: document.querySelector('#snapshot-slider') as HTMLInputElement,
  snapshotLabel: document.querySelector('#snapshot-label')!,
  snapshotCount: document.querySelector('#snapshot-count')!,
  metadataPath: document.querySelector('#metadata-path')!,
  metadataSummary: document.querySelector('#metadata-summary')!,
  metadataJson: document.querySelector('#metadata-json')!,
  manifestListPath: document.querySelector('#manifest-list-path')!,
  manifestListContent: document.querySelector('#manifest-list-content')!,
  manifestsContent: document.querySelector('#manifests-content')!,
  parquetContent: document.querySelector('#parquet-content')!,
  diffContent: document.querySelector('#diff-content')!,
  toast: document.querySelector('#toast')!,
}

function showToast(message: string) {
  els.toast.textContent = message
  els.toast.classList.remove('hidden')
  setTimeout(() => els.toast.classList.add('hidden'), 2500)
}

function basename(path: string | null | undefined) {
  if (!path) return '(none)'
  return path.split('/').pop()
}

function escapeHtml(text: unknown) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function renderRows(rows: Array<Record<string, string>>) {
  els.rowsBody.innerHTML = ''
  if (!rows.length) {
    els.rowsBody.innerHTML =
      '<tr><td colspan="3" class="empty">No rows yet — add one to create the first snapshot.</td></tr>'
    return
  }
  for (const row of rows) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.state)}</td><td>${escapeHtml(row.value)}</td>`
    els.rowsBody.appendChild(tr)
  }
}

function renderPartitions(partitions: PartitionInfo[]) {
  const needsCompaction = partitions.filter((p) => p.needs_compaction)
  if (!partitions.length) {
    els.partitionHint.textContent = 'No partitions yet.'
    els.compactBtn.disabled = true
    return
  }
  if (!needsCompaction.length) {
    els.partitionHint.textContent = 'All partitions have one data file each.'
    els.compactBtn.disabled = true
    return
  }
  const summary = needsCompaction
    .map((p) => `month=${p.date_month}/bucket=${p.state_bucket_10} (${p.file_count} files)`)
    .join(', ')
  els.partitionHint.textContent = `Can compact: ${summary}`
  els.compactBtn.disabled = false
}

function renderSnapshotList() {
  const max = Math.max(0, state.snapshots.length - 1)
  els.slider.max = String(max)
  els.slider.value = String(state.currentIndex)
  els.snapshotCount.textContent = `${state.snapshots.length} snapshot(s)`
  const snap = state.snapshots[state.currentIndex]
  if (!snap) {
    els.snapshotLabel.textContent = 'No snapshots'
    return
  }
  const actionClass = snap.action === 'compact' ? 'action-compact' : ''
  els.snapshotLabel.innerHTML = `
    <strong>#${snap.index}</strong> · ${escapeHtml(snap.label)}<br />
    <span class="muted ${actionClass}">snapshot-id: ${snap.snapshot_id ?? 'none'} · ${snap.row_count} row(s) · ${snap.action}</span>
  `
}

function renderMetadata(snapshot: ReturnType<IcebergExplainer['getSnapshot']>) {
  const meta = snapshot.metadata
  els.metadataPath.textContent = snapshot.metadata_location || '(no metadata file yet)'
  els.metadataSummary.innerHTML = `
    <strong>current-snapshot-id:</strong> ${meta['current-snapshot-id'] ?? 'null'} ·
    <strong>snapshots:</strong> ${(meta.snapshots || []).length} ·
    <strong>schema fields:</strong> date, state, value ·
    <strong>partitions:</strong> date → month, state → bucket[10]
  `
  els.metadataJson.textContent = toJson(meta)
}

function renderManifestList(snapshot: ReturnType<IcebergExplainer['getSnapshot']>) {
  els.manifestListPath.textContent =
    snapshot.manifest_list_path || '(no manifest list yet — table is empty)'
  const entries = snapshot.manifest_list || []
  if (!entries.length) {
    els.manifestListContent.innerHTML =
      '<p class="empty">Manifest list appears after the first data write.</p>'
    return
  }
  els.manifestListContent.innerHTML = entries
    .map(
      (entry, i) => `
      <div class="card">
        <h3>Entry ${i + 1}</h3>
        <div class="path">${escapeHtml(String(entry.manifest_path ?? ''))}</div>
        <div class="kv-grid">
          <div><strong>Content</strong>${entry.content}</div>
          <div><strong>Added snapshot</strong>${entry.added_snapshot_id}</div>
          <div><strong>Added files</strong>${entry.added_files_count}</div>
          <div><strong>Existing files</strong>${entry.existing_files_count}</div>
          <div><strong>Deleted files</strong>${entry.deleted_files_count}</div>
          <div><strong>Partition spec id</strong>${entry.partition_spec_id}</div>
        </div>
        <pre>${escapeHtml(toJson(entry))}</pre>
      </div>`,
    )
    .join('')
}

function renderDataTable(columns: string[], rows: Array<Record<string, string>>) {
  if (!rows.length) return '<p class="empty">No rows in this file.</p>'
  const header = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')
  const body = rows
    .map(
      (row) =>
        `<tr>${columns.map((c) => `<td>${escapeHtml(row[c] ?? '')}</td>`).join('')}</tr>`,
    )
    .join('')
  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`
}

function renderStatsTable(columns: Array<Record<string, unknown>>) {
  if (!columns.length) return '<p class="empty">No column statistics in this row group.</p>'
  const body = columns
    .map(
      (col) => `
    <tr>
      <td>${escapeHtml(col.column)}</td>
      <td>${escapeHtml(col.physical_type ?? '')}</td>
      <td>${escapeHtml(col.min ?? '—')}</td>
      <td>${escapeHtml(col.max ?? '—')}</td>
      <td>${col.null_count ?? '—'}</td>
      <td>${col.num_values ?? '—'}</td>
    </tr>`,
    )
    .join('')
  return `<div class="table-wrap"><table><thead><tr>
      <th>column</th><th>type</th><th>min</th><th>max</th><th>nulls</th><th>values</th>
    </tr></thead><tbody>${body}</tbody></table></div>`
}

function renderParquet(data: Awaited<ReturnType<typeof readParquetFiles>>) {
  const files = data?.files || []
  if (!files.length) {
    els.parquetContent.innerHTML =
      '<p class="empty">No Parquet data files yet — add a row first.</p>'
    return
  }
  els.parquetContent.innerHTML = files
    .map((file, i) => {
      const rowGroups = ((file.row_groups as Array<Record<string, unknown>>) || [])
        .map(
          (rg) => `
          <div class="subcard">
            <h4>Row group ${rg.index} · ${rg.num_rows} row(s) · ${rg.total_byte_size} bytes</h4>
            <p class="hint">Statistics stored in the Parquet footer for this row group:</p>
            ${renderStatsTable((rg.columns as Array<Record<string, unknown>>) || [])}
          </div>`,
        )
        .join('')
      const icebergStats = ((file.iceberg_manifest_stats as Array<Record<string, unknown>>) || [])
        .map(
          (col) => `
          <tr>
            <td>${escapeHtml(col.column)}</td>
            <td>${escapeHtml(col.lower_bound ?? '—')}</td>
            <td>${escapeHtml(col.upper_bound ?? '—')}</td>
            <td>${col.null_count ?? '—'}</td>
            <td>${col.value_count ?? '—'}</td>
          </tr>`,
        )
        .join('')
      return `
        <div class="card">
          <h3>Data file ${i + 1}</h3>
          <div class="path">${escapeHtml(file.path)}</div>
          <div class="kv-grid">
            <div><strong>Rows</strong>${file.num_rows}</div>
            <div><strong>Size</strong>${file.file_size_bytes} bytes</div>
            <div><strong>Partition</strong>${escapeHtml(toJson(file.partition))}</div>
          </div>
          <h4>Rows in file</h4>
          ${renderDataTable((file.columns as string[]) || [], (file.rows as Array<Record<string, string>>) || [])}
          <h4>Parquet footer statistics</h4>
          ${rowGroups || '<p class="empty">No row group statistics.</p>'}
          <div class="subcard">
            <h4>Iceberg manifest stats (copied into metadata)</h4>
            <div class="table-wrap"><table><thead><tr>
              <th>column</th><th>lower</th><th>upper</th><th>nulls</th><th>values</th>
            </tr></thead><tbody>${icebergStats}</tbody></table></div>
          </div>
        </div>`
    })
    .join('')
}

function renderManifests(snapshot: ReturnType<IcebergExplainer['getSnapshot']>) {
  const manifests = snapshot.manifests || []
  if (!manifests.length) {
    els.manifestsContent.innerHTML =
      '<p class="empty">Manifest files appear after the first data write.</p>'
    return
  }
  els.manifestsContent.innerHTML = manifests
    .map((manifest, i) => {
      const entries = manifest.entries || []
      const entryRows = entries
        .map((e) => {
          const raw = e as Record<string, unknown>
          const dataFile = (raw.data_file as Record<string, unknown>) || {}
          const partition = dataFile.partition || raw.partition || {}
          return `<tr>
            <td>${escapeHtml(toJson(partition))}</td>
            <td>${escapeHtml(basename(String(dataFile.file_path ?? '')))}</td>
            <td>${raw.status}</td>
            <td>${raw.file_sequence_number ?? ''}</td>
          </tr>`
        })
        .join('')
      return `
        <div class="card">
          <h3>Manifest ${i + 1}</h3>
          <div class="path">${escapeHtml(manifest.path)}</div>
          <table><thead><tr><th>partition</th><th>data file</th><th>status</th><th>seq</th></tr></thead>
          <tbody>${entryRows}</tbody></table>
          <details><summary>Raw manifest entries</summary><pre>${escapeHtml(toJson(entries))}</pre></details>
        </div>`
    })
    .join('')
}

function renderDiff(diff: Record<string, unknown> | null) {
  if (!diff) {
    els.diffContent.innerHTML =
      '<p class="empty">Select a snapshot after the first one to see changes.</p>'
    return
  }
  const meta = (diff.metadata as Record<string, unknown>) || {}
  const ml = (diff.manifest_list_diff as Record<string, unknown>) || {}
  els.diffContent.innerHTML = `
    <div class="callout">
      Comparing <strong>#${diff.from_index}</strong> (${escapeHtml(diff.from_label)})
      → <strong>#${diff.to_index}</strong> (${escapeHtml(diff.to_label)})
    </div>
    <div class="kv-grid">
      <div><strong>Snapshot id before</strong>${(meta.current_snapshot_id as Record<string, unknown>)?.before ?? 'null'}</div>
      <div><strong>Snapshot id after</strong>${(meta.current_snapshot_id as Record<string, unknown>)?.after ?? 'null'}</div>
      <div><strong>Manifest list entries before</strong>${ml.before_count}</div>
      <div><strong>Manifest list entries after</strong>${ml.after_count}</div>
    </div>
    <div class="card"><h3 class="diff-added">New snapshot(s)</h3><pre>${escapeHtml(toJson(meta.new_snapshots))}</pre></div>
    <details><summary>Manifest list before / after</summary>
      <h4>Before</h4><pre>${escapeHtml(toJson(ml.before))}</pre>
      <h4>After</h4><pre>${escapeHtml(toJson(ml.after))}</pre>
    </details>`
}

async function loadParquet(explainer: IcebergExplainer, index: number) {
  if (state.parquetCache[index]) {
    renderParquet(state.parquetCache[index])
    return
  }
  els.parquetContent.innerHTML = '<p class="muted">Loading Parquet files…</p>'
  const snapshot = explainer.getSnapshot(index)
  const data = await readParquetFiles(snapshot, explainer.getStore())
  state.parquetCache[index] = data
  renderParquet(data)
}

async function loadSnapshotDetail(explainer: IcebergExplainer, index: number) {
  const snapshot = explainer.getSnapshot(index)
  renderMetadata(snapshot)
  renderManifestList(snapshot)
  renderManifests(snapshot)
  await loadParquet(explainer, index)
  if (index > 0) {
    const before = explainer.getSnapshot(index - 1)
    const after = explainer.getSnapshot(index)
    renderDiff(
      diffSnapshots(
        before,
        after,
        before.label,
        after.label,
        index - 1,
        index,
      ),
    )
  } else {
    renderDiff(null)
  }
}

async function refreshAll(explainer: IcebergExplainer, selectIndex: number | null = null) {
  const rows = await explainer.getRows()
  const partitions = explainer.getPartitions() as PartitionInfo[]
  state.snapshots = explainer.listSnapshots()
  state.parquetCache = {}
  state.currentIndex =
    selectIndex !== null ? selectIndex : Math.max(0, state.snapshots.length - 1)
  renderRows(rows)
  renderPartitions(partitions)
  renderSnapshotList()
  await loadSnapshotDetail(explainer, state.currentIndex)
}

export async function initApp(explainer: IcebergExplainer) {
  if (new URLSearchParams(location.search).has('embed')) {
    document.body.classList.add('embed')
  }

  els.compactBtn.disabled = true

  els.addForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(els.addForm)
    try {
      const idx = await explainer.addRow(
        String(form.get('date')),
        String(form.get('state')),
        String(form.get('value')),
      )
      els.addForm.reset()
      await refreshAll(explainer, idx)
      showToast('Row appended — new snapshot created')
    } catch (err) {
      showToast(`Error: ${(err as Error).message}`)
    }
  })

  els.resetBtn.addEventListener('click', async () => {
    if (!confirm('Drop the table and delete all snapshots?')) return
    try {
      const idx = await explainer.reset()
      await refreshAll(explainer, idx)
      showToast('Table reset')
    } catch (err) {
      showToast(`Error: ${(err as Error).message}`)
    }
  })

  els.compactBtn.addEventListener('click', async () => {
    try {
      const idx = await explainer.compact()
      await refreshAll(explainer, idx)
      showToast(explainer.listSnapshots()[idx]?.label ?? 'Compacted')
    } catch (err) {
      showToast(`Error: ${(err as Error).message}`)
    }
  })

  els.slider.addEventListener('input', async () => {
    state.currentIndex = Number(els.slider.value)
    renderSnapshotList()
    await loadSnapshotDetail(explainer, state.currentIndex)
  })

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'))
      tab.classList.add('active')
      document
        .querySelector(`#tab-${(tab as HTMLElement).dataset.tab}`)!
        .classList.add('active')
      if ((tab as HTMLElement).dataset.tab === 'parquet') {
        await loadParquet(explainer, state.currentIndex)
      }
    })
  })

  await refreshAll(explainer)
}
