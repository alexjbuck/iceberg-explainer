import { replayVariants, type VariantResult } from './compare.js'
import type { OperationLog } from './operationLog.js'
import {
  cloneConfig,
  DEFAULT_TABLE_CONFIG,
  describePartitionSpec,
  presetIndexForConfig,
  stateTransformToIceberg,
  TABLE_CONFIG_PRESETS,
  type DateTransform,
  type SortFieldConfig,
  type StateTransformKind,
  type TableConfig,
} from './tableConfig.js'

type AdvancedModeDeps = {
  operationLog: OperationLog
  getPrimaryConfig: () => TableConfig
  getSnapshotIndex: () => number
}

const MAX_VARIANTS = 3

const DATE_OPTIONS: DateTransform[] = ['year', 'month', 'day', 'identity']
const STATE_KIND_OPTIONS: StateTransformKind[] = ['identity', 'bucket', 'truncate']

const SORT_PRESETS: { label: string; fields: SortFieldConfig[] }[] = [
  { label: 'Unsorted', fields: [] },
  { label: 'date asc', fields: [{ column: 'date', direction: 'asc' }] },
  { label: 'state asc, date asc', fields: [
    { column: 'state', direction: 'asc' },
    { column: 'date', direction: 'asc' },
  ]},
]

function escapeHtml(text: unknown) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function defaultVariants(): TableConfig[] {
  return [
    cloneConfig(TABLE_CONFIG_PRESETS[1], 'variant-0', 'Year + bucket[10]'),
    cloneConfig(TABLE_CONFIG_PRESETS[2], 'variant-1', 'Month + identity'),
  ]
}

function readStateTransform(index: number) {
  const kind = (document.querySelector(`#variant-${index}-state-kind`) as HTMLSelectElement)
    .value as StateTransformKind
  const n = Math.max(
    1,
    Number((document.querySelector(`#variant-${index}-state-n`) as HTMLInputElement).value) || 1,
  )
  return kind === 'identity' ? { kind, n: 0 } : { kind, n }
}

export function initAdvancedMode(deps: AdvancedModeDeps) {
  const toggle = document.querySelector('#advanced-toggle') as HTMLInputElement
  const toggleText = document.querySelector('#advanced-toggle-text')!
  const panel = document.querySelector('#advanced-panel')!
  const scriptEl = document.querySelector('#operation-script')!
  const variantsEl = document.querySelector('#compare-variants')!
  const resultsEl = document.querySelector('#compare-results')!
  const addBtn = document.querySelector('#add-variant-btn') as HTMLButtonElement

  let variants = defaultVariants()
  let compareToken = 0

  function setAdvancedVisible(on: boolean) {
    document.body.classList.toggle('advanced-mode', on)
    panel.classList.toggle('hidden', !on)
    toggleText.textContent = on ? 'Advanced mode — panel below ↓' : 'Advanced mode'
    if (on) {
      panel.classList.remove('advanced-panel-enter')
      void (panel as HTMLElement).offsetWidth
      panel.classList.add('advanced-panel-enter')
      requestAnimationFrame(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
      void refreshComparison()
    } else {
      panel.classList.remove('advanced-panel-enter')
    }
  }

  toggle.addEventListener('change', () => {
    setAdvancedVisible(toggle.checked)
  })

  addBtn.addEventListener('click', () => {
    if (variants.length >= MAX_VARIANTS) return
    const preset = TABLE_CONFIG_PRESETS[(variants.length + 2) % TABLE_CONFIG_PRESETS.length]
    variants.push(cloneConfig(preset, `variant-${variants.length}`, preset.name))
    renderVariants()
    void refreshComparison()
  })

  function readConfigFromForm(index: number): TableConfig {
    const base = variants[index]
    const date = (document.querySelector(`#variant-${index}-date`) as HTMLSelectElement).value as DateTransform
    const sortIdx = Number((document.querySelector(`#variant-${index}-sort`) as HTMLSelectElement).value)
    const name = (document.querySelector(`#variant-${index}-name`) as HTMLInputElement).value.trim() || base.name
    return {
      ...base,
      name,
      dateTransform: date,
      stateTransform: readStateTransform(index),
      sortFields: SORT_PRESETS[sortIdx]?.fields.map((f) => ({ ...f })) ?? [],
    }
  }

  function applyPreset(index: number, presetId: string) {
    const preset = TABLE_CONFIG_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    variants[index] = cloneConfig(preset, variants[index].id, preset.name)
    renderVariants()
    void refreshComparison()
  }

  function renderVariantCard(config: TableConfig, index: number) {
    const sortIndex = SORT_PRESETS.findIndex(
      (p) => JSON.stringify(p.fields) === JSON.stringify(config.sortFields),
    )
    const presetIdx = presetIndexForConfig(config)
    const presetOptions = [
      `<option value="">Custom</option>`,
      ...TABLE_CONFIG_PRESETS.map(
        (p, i) =>
          `<option value="${p.id}" ${i === presetIdx ? 'selected' : ''}>${escapeHtml(p.name)}</option>`,
      ),
    ].join('')
    const dateOptions = DATE_OPTIONS.map(
      (t) => `<option value="${t}" ${t === config.dateTransform ? 'selected' : ''}>${t}</option>`,
    ).join('')
    const stateKindOptions = STATE_KIND_OPTIONS.map(
      (t) =>
        `<option value="${t}" ${t === config.stateTransform.kind ? 'selected' : ''}>${t}</option>`,
    ).join('')
    const sortOptions = SORT_PRESETS.map(
      (p, i) => `<option value="${i}" ${i === (sortIndex >= 0 ? sortIndex : 0) ? 'selected' : ''}>${escapeHtml(p.label)}</option>`,
    ).join('')
    const showStateN = config.stateTransform.kind !== 'identity'
    const stateN = config.stateTransform.kind === 'identity' ? 10 : config.stateTransform.n

    return `
      <div class="variant-card" data-variant-index="${index}">
        <div class="variant-card-header">
          <input id="variant-${index}-name" type="text" value="${escapeHtml(config.name)}" aria-label="Variant name" />
          ${variants.length > 1 ? `<button type="button" class="secondary compact remove-variant" data-index="${index}">Remove</button>` : ''}
        </div>
        <label>Preset
          <select class="variant-preset" data-index="${index}">${presetOptions}</select>
        </label>
        <label>date transform
          <select id="variant-${index}-date">${dateOptions}</select>
        </label>
        <div class="state-transform-row">
          <label>state transform
            <select id="variant-${index}-state-kind">${stateKindOptions}</select>
          </label>
          <label class="state-n-label ${showStateN ? '' : 'hidden'}">
            N
            <input id="variant-${index}-state-n" type="number" min="1" max="9999" value="${stateN}" />
          </label>
        </div>
        <p class="muted state-transform-hint">${escapeHtml(stateTransformHint(config))}</p>
        <label>sort order
          <select id="variant-${index}-sort">${sortOptions}</select>
        </label>
        <p class="muted variant-desc">${escapeHtml(describePartitionSpec(config))}</p>
      </div>`
  }

  function stateTransformHint(config: TableConfig): string {
    const t = config.stateTransform
    if (t.kind === 'identity') return 'identity — one partition per distinct state value'
    if (t.kind === 'bucket') return `bucket[${t.n}] — hash state into ${t.n} buckets`
    return `truncate[${t.n}] — first ${t.n} chars of state`
  }

  function bindVariantEvents() {
    variantsEl.querySelectorAll('.variant-preset').forEach((el) => {
      el.addEventListener('change', () => {
        const presetId = (el as HTMLSelectElement).value
        if (!presetId) return
        applyPreset(Number((el as HTMLElement).dataset.index), presetId)
      })
    })

    variantsEl.querySelectorAll('.remove-variant').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number((el as HTMLElement).dataset.index)
        variants.splice(idx, 1)
        renderVariants()
        void refreshComparison()
      })
    })

    variantsEl.querySelectorAll('select:not(.variant-preset)').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = Number((el as HTMLElement).closest('[data-variant-index]')?.getAttribute('data-variant-index'))
        if (Number.isNaN(idx)) return
        if ((el as HTMLElement).id.endsWith('-state-kind')) {
          const kind = (el as HTMLSelectElement).value as StateTransformKind
          const nWrap = variantsEl.querySelector(`[data-variant-index="${idx}"] .state-n-label`)
          nWrap?.classList.toggle('hidden', kind === 'identity')
        }
        variants[idx] = readConfigFromForm(idx)
        updateVariantDesc(idx)
        void refreshComparison()
      })
    })

    variantsEl.querySelectorAll('input[type="text"]').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = Number((el as HTMLElement).closest('[data-variant-index]')?.getAttribute('data-variant-index'))
        if (Number.isNaN(idx)) return
        variants[idx] = readConfigFromForm(idx)
        void refreshComparison()
      })
    })

    variantsEl.querySelectorAll('input[type="number"]').forEach((el) => {
      el.addEventListener('change', () => {
        const idx = Number((el as HTMLElement).closest('[data-variant-index]')?.getAttribute('data-variant-index'))
        if (Number.isNaN(idx)) return
        variants[idx] = readConfigFromForm(idx)
        updateVariantDesc(idx)
        void refreshComparison()
      })
    })
  }

  function updateVariantDesc(index: number) {
    const card = variantsEl.querySelector(`[data-variant-index="${index}"]`)
    if (!card) return
    const desc = card.querySelector('.variant-desc')
    const hint = card.querySelector('.state-transform-hint')
    if (desc) desc.textContent = describePartitionSpec(variants[index])
    if (hint) hint.textContent = stateTransformHint(variants[index])
  }

  function renderVariants() {
    variantsEl.innerHTML = variants.map((v, i) => renderVariantCard(v, i)).join('')
    addBtn.disabled = variants.length >= MAX_VARIANTS
    bindVariantEvents()
  }

  function metricCell(value: number | string, baseline: number | string | null, lowerIsBetter = true) {
    if (baseline == null || value === baseline) {
      return `<td>${escapeHtml(value)}</td>`
    }
    const num = Number(value)
    const baseNum = Number(baseline)
    if (Number.isNaN(num) || Number.isNaN(baseNum)) {
      return `<td>${escapeHtml(value)}</td>`
    }
    const better = lowerIsBetter ? num < baseNum : num > baseNum
    const worse = lowerIsBetter ? num > baseNum : num < baseNum
    const cls = better ? 'metric-better' : worse ? 'metric-worse' : ''
    return `<td class="${cls}">${escapeHtml(value)}</td>`
  }

  function renderPartitionsBlock(result: VariantResult) {
    if (result.error) {
      return `<p class="empty">${escapeHtml(result.error)}</p>`
    }
    if (!result.partitions.length) {
      return '<p class="empty">No partitions yet.</p>'
    }
    const rows = result.partitions
      .map(
        (p) =>
          `<tr><td>${escapeHtml(p.partition_label)}</td><td>${p.file_count}</td><td>${p.record_count}</td></tr>`,
      )
      .join('')
    return `<div class="table-wrap"><table><thead><tr><th>partition</th><th>files</th><th>rows</th></tr></thead><tbody>${rows}</tbody></table></div>`
  }

  function renderResults(
    primary: VariantResult,
    variantResults: VariantResult[],
    snapshotIndex: number,
  ) {
    const columns = [primary, ...variantResults]
    const base = primary.metrics

    const metricRows: { label: string; key: keyof NonNullable<VariantResult['metrics']>; lowerBetter: boolean }[] = [
      { label: 'Snapshots', key: 'snapshot_count', lowerBetter: false },
      { label: 'Visible rows', key: 'row_count', lowerBetter: false },
      { label: 'Data files', key: 'data_file_count', lowerBetter: true },
      { label: 'Position delete files', key: 'delete_file_count', lowerBetter: true },
      { label: 'Pending delete files', key: 'pending_delete_files', lowerBetter: true },
      { label: 'Partitions', key: 'partition_count', lowerBetter: true },
      { label: 'Partitions needing compact', key: 'partitions_needing_compaction', lowerBetter: true },
      { label: 'Manifest files', key: 'manifest_count', lowerBetter: true },
    ]

    const header = columns
      .map((c) => `<th>${escapeHtml(c.config.name)}<br /><span class="muted">${escapeHtml(describePartitionSpec(c.config))}</span></th>`)
      .join('')

    const body = metricRows
      .map((row) => {
        const cells = columns
          .map((col) => {
            if (col.error || !col.metrics) return '<td class="metric-error">—</td>'
            const val = col.metrics[row.key]
            const baseVal = base?.[row.key] ?? null
            return metricCell(val, col === primary ? null : baseVal, row.lowerBetter)
          })
          .join('')
        return `<tr><th>${row.label}</th>${cells}</tr>`
      })
      .join('')

    const partitionBlocks = columns
      .map(
        (col) => `
        <div class="compare-partitions-col">
          <h4>${escapeHtml(col.config.name)}</h4>
          ${renderPartitionsBlock(col)}
        </div>`,
      )
      .join('')

    resultsEl.innerHTML = `
      <p class="hint">Metrics at snapshot <strong>#${snapshotIndex}</strong> after replaying your operation history.</p>
      <div class="table-wrap compare-metrics">
        <table><thead><tr><th>Metric</th>${header}</tr></thead><tbody>${body}</tbody></table>
      </div>
      <h3>Partition layout</h3>
      <div class="compare-partitions">${partitionBlocks}</div>`
  }

  async function refreshComparison() {
    const token = ++compareToken
    scriptEl.textContent = deps.operationLog.describe() || '(no operations yet)'
    resultsEl.innerHTML = '<p class="muted">Replaying operations in your browser…</p>'

    variants = variants.map((_, i) => {
      const card = variantsEl.querySelector(`[data-variant-index="${i}"]`)
      return card ? readConfigFromForm(i) : variants[i]
    })

    const primaryConfig = deps.getPrimaryConfig()
    const snapshotIndex = deps.getSnapshotIndex()
    const { primary, variants: variantResults } = await replayVariants(
      primaryConfig,
      variants,
      deps.operationLog.getOperations(),
      snapshotIndex,
    )

    if (token !== compareToken) return
    renderResults(primary, variantResults, snapshotIndex)
  }

  renderVariants()

  return {
    refresh: refreshComparison,
    isEnabled: () => toggle.checked,
  }
}

export { DEFAULT_TABLE_CONFIG, describePartitionSpec, stateTransformToIceberg }
