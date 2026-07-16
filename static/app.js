const state = {
  snapshots: [],
  currentIndex: 0,
  activeTab: "metadata",
  parquetCache: {},
};

const els = {
  rowsBody: document.querySelector("#rows-table tbody"),
  addForm: document.querySelector("#add-row-form"),
  resetBtn: document.querySelector("#reset-btn"),
  compactBtn: document.querySelector("#compact-btn"),
  partitionHint: document.querySelector("#partition-hint"),
  slider: document.querySelector("#snapshot-slider"),
  snapshotLabel: document.querySelector("#snapshot-label"),
  snapshotCount: document.querySelector("#snapshot-count"),
  metadataPath: document.querySelector("#metadata-path"),
  metadataSummary: document.querySelector("#metadata-summary"),
  metadataJson: document.querySelector("#metadata-json"),
  manifestListPath: document.querySelector("#manifest-list-path"),
  manifestListContent: document.querySelector("#manifest-list-content"),
  manifestsContent: document.querySelector("#manifests-content"),
  parquetContent: document.querySelector("#parquet-content"),
  diffContent: document.querySelector("#diff-content"),
  toast: document.querySelector("#toast"),
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || res.statusText);
  }
  return res.json();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  setTimeout(() => els.toast.classList.add("hidden"), 2500);
}

function basename(path) {
  if (!path) return "(none)";
  return path.split("/").pop();
}

function renderRows(rows) {
  els.rowsBody.innerHTML = "";
  if (!rows.length) {
    els.rowsBody.innerHTML =
      '<tr><td colspan="3" class="empty">No rows yet — add one to create the first snapshot.</td></tr>';
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.state)}</td><td>${escapeHtml(row.value)}</td>`;
    els.rowsBody.appendChild(tr);
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderPartitions(partitions) {
  const needsCompaction = partitions.filter((p) => p.needs_compaction);
  if (!partitions.length) {
    els.partitionHint.textContent = "No partitions yet.";
    els.compactBtn.disabled = true;
    return;
  }
  if (!needsCompaction.length) {
    els.partitionHint.textContent = "All partitions have one data file each.";
    els.compactBtn.disabled = true;
    return;
  }

  const summary = needsCompaction
    .map((p) => `month=${p.date_month}/bucket=${p.state_bucket_10} (${p.file_count} files)`)
    .join(", ");
  els.partitionHint.textContent = `Can compact: ${summary}`;
  els.compactBtn.disabled = false;
}

function renderSnapshotList() {
  const max = Math.max(0, state.snapshots.length - 1);
  els.slider.max = String(max);
  els.slider.value = String(state.currentIndex);
  els.snapshotCount.textContent = `${state.snapshots.length} snapshot(s)`;

  const snap = state.snapshots[state.currentIndex];
  if (!snap) {
    els.snapshotLabel.textContent = "No snapshots";
    return;
  }
  const actionClass = snap.action === "compact" ? "action-compact" : "";
  els.snapshotLabel.innerHTML = `
    <strong>#${snap.index}</strong> · ${escapeHtml(snap.label)}<br />
    <span class="muted ${actionClass}">snapshot-id: ${snap.snapshot_id ?? "none"} · ${snap.row_count} row(s) · ${snap.action}</span>
  `;
}

function renderMetadata(snapshot) {
  const meta = snapshot.metadata || {};
  els.metadataPath.textContent = snapshot.metadata_location || "(no metadata file yet)";
  els.metadataSummary.innerHTML = `
    <strong>current-snapshot-id:</strong> ${meta["current-snapshot-id"] ?? "null"} ·
    <strong>snapshots:</strong> ${(meta.snapshots || []).length} ·
    <strong>schema fields:</strong> date, state, value ·
    <strong>partitions:</strong> date → month, state → bucket[10]
  `;
  els.metadataJson.textContent = JSON.stringify(meta, null, 2);
}

function renderManifestList(snapshot) {
  els.manifestListPath.textContent = snapshot.manifest_list_path || "(no manifest list yet — table is empty)";
  const entries = snapshot.manifest_list || [];
  if (!entries.length) {
    els.manifestListContent.innerHTML = '<p class="empty">Manifest list appears after the first data write.</p>';
    return;
  }

  els.manifestListContent.innerHTML = entries
    .map(
      (entry, i) => `
      <div class="card">
        <h3>Entry ${i + 1}</h3>
        <div class="path">${escapeHtml(entry.manifest_path)}</div>
        <div class="kv-grid">
          <div><strong>Content</strong>${entry.content}</div>
          <div><strong>Added snapshot</strong>${entry.added_snapshot_id}</div>
          <div><strong>Added files</strong>${entry.added_files_count}</div>
          <div><strong>Existing files</strong>${entry.existing_files_count}</div>
          <div><strong>Deleted files</strong>${entry.deleted_files_count}</div>
          <div><strong>Partition spec id</strong>${entry.partition_spec_id}</div>
        </div>
        <pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
      </div>`
    )
    .join("");
}

function renderDataTable(columns, rows) {
  if (!rows.length) {
    return '<p class="empty">No rows in this file.</p>';
  }
  const header = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${columns.map((c) => `<td>${escapeHtml(row[c] ?? "")}</td>`).join("")}</tr>`
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderStatsTable(columns) {
  if (!columns.length) {
    return '<p class="empty">No column statistics in this row group.</p>';
  }
  const header = `
    <tr>
      <th>column</th>
      <th>type</th>
      <th>min</th>
      <th>max</th>
      <th>nulls</th>
      <th>values</th>
    </tr>`;
  const body = columns
    .map(
      (col) => `
    <tr>
      <td>${escapeHtml(col.column)}</td>
      <td>${escapeHtml(col.physical_type || "")}</td>
      <td>${escapeHtml(col.min ?? "—")}</td>
      <td>${escapeHtml(col.max ?? "—")}</td>
      <td>${col.null_count ?? "—"}</td>
      <td>${col.num_values ?? "—"}</td>
    </tr>`
    )
    .join("");
  return `<div class="table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
}

function renderParquet(data) {
  const files = data?.files || [];
  if (!files.length) {
    els.parquetContent.innerHTML =
      '<p class="empty">No Parquet data files yet — add a row first.</p>';
    return;
  }

  els.parquetContent.innerHTML = files
    .map((file, i) => {
      const rowGroups = (file.row_groups || [])
        .map(
          (rg) => `
          <div class="subcard">
            <h4>Row group ${rg.index} · ${rg.num_rows} row(s) · ${rg.total_byte_size} bytes</h4>
            <p class="hint">Statistics stored in the Parquet footer for this row group:</p>
            ${renderStatsTable(rg.columns || [])}
          </div>`
        )
        .join("");

      const icebergStats = (file.iceberg_manifest_stats || [])
        .map(
          (col) => `
          <tr>
            <td>${escapeHtml(col.column)}</td>
            <td>${escapeHtml(col.lower_bound ?? "—")}</td>
            <td>${escapeHtml(col.upper_bound ?? "—")}</td>
            <td>${col.null_count ?? "—"}</td>
            <td>${col.value_count ?? "—"}</td>
          </tr>`
        )
        .join("");

      const icebergTable = icebergStats
        ? `<div class="subcard">
            <h4>Iceberg manifest stats (copied into metadata)</h4>
            <p class="hint">These bounds are what Iceberg stores on the data file entry in the manifest — used for pruning.</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>column</th>
                    <th>lower bound</th>
                    <th>upper bound</th>
                    <th>null count</th>
                    <th>value count</th>
                  </tr>
                </thead>
                <tbody>${icebergStats}</tbody>
              </table>
            </div>
          </div>`
        : "";

      return `
        <div class="card">
          <h3>Data file ${i + 1}</h3>
          <div class="path">${escapeHtml(file.path)}</div>
          <div class="kv-grid">
            <div><strong>Rows</strong>${file.num_rows}</div>
            <div><strong>Size</strong>${file.file_size_bytes} bytes</div>
            <div><strong>Partition</strong>${escapeHtml(JSON.stringify(file.partition || {}))}</div>
          </div>

          <h4>Rows in file</h4>
          ${renderDataTable(file.columns || [], file.rows || [])}

          <h4>Parquet footer statistics</h4>
          ${rowGroups || '<p class="empty">No row group statistics.</p>'}

          ${icebergTable}
        </div>`;
    })
    .join("");
}

async function loadParquet(index) {
  if (state.parquetCache[index]) {
    renderParquet(state.parquetCache[index]);
    return;
  }
  els.parquetContent.innerHTML = '<p class="muted">Loading Parquet files…</p>';
  try {
    const data = await api(`/api/snapshots/${index}/parquet`);
    state.parquetCache[index] = data;
    renderParquet(data);
  } catch (err) {
    els.parquetContent.innerHTML = `<p class="empty">Failed to load Parquet files: ${escapeHtml(err.message)}</p>`;
  }
}

function renderManifests(snapshot) {
  const manifests = snapshot.manifests || [];
  if (!manifests.length) {
    els.manifestsContent.innerHTML = '<p class="empty">Manifest files appear after the first data write.</p>';
    return;
  }

  els.manifestsContent.innerHTML = manifests
    .map((manifest, i) => {
      const entries = manifest.entries || [];
      const entryRows = entries
        .map((e) => {
          const dataFile = e.data_file || {};
          const partition = dataFile.partition || e.partition || {};
          return `
          <tr>
            <td>${escapeHtml(JSON.stringify(partition))}</td>
            <td>${escapeHtml(basename(dataFile.file_path || ""))}</td>
            <td>${e.status}</td>
            <td>${e.file_sequence_number ?? ""}</td>
          </tr>`;
        })
        .join("");

      return `
        <div class="card">
          <h3>Manifest ${i + 1}</h3>
          <div class="path">${escapeHtml(manifest.path)}</div>
          <div class="kv-grid">
            <div><strong>Entries</strong>${entries.length}</div>
            <div><strong>From list entry</strong>${manifest.manifest_list_entry?.added_files_count ?? 0} added files</div>
          </div>
          <table>
            <thead>
              <tr>
                <th>partition</th>
                <th>data file</th>
                <th>status</th>
                <th>seq</th>
              </tr>
            </thead>
            <tbody>${entryRows || '<tr><td colspan="4" class="empty">No entries</td></tr>'}</tbody>
          </table>
          <details>
            <summary>Raw manifest entries</summary>
            <pre>${escapeHtml(JSON.stringify(entries, null, 2))}</pre>
          </details>
        </div>`;
    })
    .join("");
}

function renderDiff(diff) {
  if (!diff) {
    els.diffContent.innerHTML = '<p class="empty">Select a snapshot after the first one to see changes.</p>';
    return;
  }

  const meta = diff.metadata || {};
  const ml = diff.manifest_list_diff || {};
  const changes = meta.full_diff || {};

  let changeHtml = "";
  if (changes.kind === "unchanged") {
    changeHtml = '<p class="empty">No metadata changes detected.</p>';
  } else {
    const sections = [];
    if (meta.new_snapshots?.length) {
      sections.push(`
        <div class="card">
          <h3 class="diff-added">New snapshot(s)</h3>
          <pre>${escapeHtml(JSON.stringify(meta.new_snapshots, null, 2))}</pre>
        </div>`);
    }
    if (changes.values_changed?.length) {
      sections.push(`
        <div class="card">
          <h3 class="diff-changed">Values changed</h3>
          <pre>${escapeHtml(JSON.stringify(changes.values_changed, null, 2))}</pre>
        </div>`);
    }
    if (changes.dictionary_item_added?.length) {
      sections.push(`
        <div class="card">
          <h3 class="diff-added">Keys added</h3>
          <pre>${escapeHtml(JSON.stringify(changes.dictionary_item_added, null, 2))}</pre>
        </div>`);
    }
    if (changes.dictionary_item_removed?.length) {
      sections.push(`
        <div class="card">
          <h3 class="diff-removed">Keys removed</h3>
          <pre>${escapeHtml(JSON.stringify(changes.dictionary_item_removed, null, 2))}</pre>
        </div>`);
    }
    changeHtml = sections.join("") || '<p class="empty">Metadata changed but no detailed diff buckets matched.</p>';
  }

  els.diffContent.innerHTML = `
    <div class="callout">
      Comparing <strong>#${diff.from_index}</strong> (${escapeHtml(diff.from_label)})
      → <strong>#${diff.to_index}</strong> (${escapeHtml(diff.to_label)})
    </div>
    <div class="kv-grid">
      <div><strong>Snapshot id before</strong>${meta.current_snapshot_id?.before ?? "null"}</div>
      <div><strong>Snapshot id after</strong>${meta.current_snapshot_id?.after ?? "null"}</div>
      <div><strong>Manifest list entries before</strong>${ml.before_count}</div>
      <div><strong>Manifest list entries after</strong>${ml.after_count}</div>
    </div>
    ${changeHtml}
    <details>
      <summary>Manifest list before / after</summary>
      <h4>Before</h4>
      <pre>${escapeHtml(JSON.stringify(ml.before, null, 2))}</pre>
      <h4>After</h4>
      <pre>${escapeHtml(JSON.stringify(ml.after, null, 2))}</pre>
    </details>
  `;
}

async function loadSnapshotDetail(index) {
  const snapshot = await api(`/api/snapshots/${index}`);
  renderMetadata(snapshot);
  renderManifestList(snapshot);
  renderManifests(snapshot);
  await loadParquet(index);

  if (index > 0) {
    const diff = await api(`/api/diff?from_index=${index - 1}&to_index=${index}`);
    renderDiff(diff);
  } else {
    renderDiff(null);
  }
}

async function refreshAll(selectIndex = null) {
  const [{ rows, partitions }, { snapshots }] = await Promise.all([
    api("/api/rows"),
    api("/api/snapshots"),
  ]);

  state.snapshots = snapshots;
  state.parquetCache = {};
  if (selectIndex !== null) {
    state.currentIndex = selectIndex;
  } else {
    state.currentIndex = Math.max(0, snapshots.length - 1);
  }

  renderRows(rows);
  renderPartitions(partitions || []);
  renderSnapshotList();
  await loadSnapshotDetail(state.currentIndex);
}

els.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.addForm);
  const payload = {
    date: form.get("date"),
    state: form.get("state"),
    value: form.get("value"),
  };
  try {
    const result = await api("/api/rows", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.addForm.reset();
    await refreshAll(result.snapshot_index);
    showToast("Row appended — new snapshot created");
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
});

els.resetBtn.addEventListener("click", async () => {
  if (!confirm("Drop the table and delete all snapshots?")) return;
  try {
    const result = await api("/api/reset", { method: "POST" });
    await refreshAll(result.snapshot_index);
    showToast("Table reset");
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
});

els.compactBtn.addEventListener("click", async () => {
  try {
    const result = await api("/api/compact", { method: "POST" });
    await refreshAll(result.snapshot_index);
    showToast(result.snapshot.label);
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
});

els.compactBtn.disabled = true;

els.slider.addEventListener("input", async () => {
  state.currentIndex = Number(els.slider.value);
  renderSnapshotList();
  await loadSnapshotDetail(state.currentIndex);
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#tab-${tab.dataset.tab}`).classList.add("active");
    state.activeTab = tab.dataset.tab;
    if (tab.dataset.tab === "parquet") {
      loadParquet(state.currentIndex);
    }
  });
});

refreshAll().catch((err) => {
  showToast(`Startup error: ${err.message}. Is RustFS running?`);
});
