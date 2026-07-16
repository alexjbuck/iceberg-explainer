import type { PartitionSpec, SortOrder } from 'icebird/src/types.js'

export type SchemaColumn = 'date' | 'state' | 'value'

export type DateTransform = 'year' | 'month' | 'day' | 'identity'

export type StateTransformKind = 'identity' | 'bucket' | 'truncate'

export type StateTransformConfig = {
  kind: StateTransformKind
  /** Bucket count or truncate width; ignored for identity. */
  n: number
}

export type SortFieldConfig = {
  column: SchemaColumn
  direction: 'asc' | 'desc'
}

export type TableConfig = {
  id: string
  name: string
  dateTransform: DateTransform
  stateTransform: StateTransformConfig
  sortFields: SortFieldConfig[]
}

const SCHEMA_FIELD_IDS: Record<SchemaColumn, number> = {
  date: 1,
  state: 2,
  value: 3,
}

export const DEFAULT_STATE_TRANSFORM: StateTransformConfig = { kind: 'bucket', n: 10 }

export const DEFAULT_TABLE_CONFIG: TableConfig = {
  id: 'default',
  name: 'Month + bucket[10]',
  dateTransform: 'month',
  stateTransform: { ...DEFAULT_STATE_TRANSFORM },
  sortFields: [],
}

export const TABLE_CONFIG_PRESETS: TableConfig[] = [
  DEFAULT_TABLE_CONFIG,
  {
    id: 'year-bucket10',
    name: 'Year + bucket[10]',
    dateTransform: 'year',
    stateTransform: { kind: 'bucket', n: 10 },
    sortFields: [],
  },
  {
    id: 'month-identity',
    name: 'Month + identity',
    dateTransform: 'month',
    stateTransform: { kind: 'identity', n: 0 },
    sortFields: [],
  },
  {
    id: 'year-identity',
    name: 'Year + identity',
    dateTransform: 'year',
    stateTransform: { kind: 'identity', n: 0 },
    sortFields: [],
  },
  {
    id: 'month-bucket3',
    name: 'Month + bucket[3]',
    dateTransform: 'month',
    stateTransform: { kind: 'bucket', n: 3 },
    sortFields: [],
  },
  {
    id: 'month-truncate3',
    name: 'Month + truncate[3]',
    dateTransform: 'month',
    stateTransform: { kind: 'truncate', n: 3 },
    sortFields: [],
  },
]

export function stateTransformToIceberg(transform: StateTransformConfig): string {
  if (transform.kind === 'identity') return 'identity'
  if (transform.kind === 'bucket') return `bucket[${transform.n}]`
  return `truncate[${transform.n}]`
}

export function formatStateTransformShort(transform: StateTransformConfig): string {
  if (transform.kind === 'identity') return 'id'
  if (transform.kind === 'bucket') return `b${transform.n}`
  return `t${transform.n}`
}

export function partitionFieldName(column: 'date' | 'state', transform: string): string {
  if (transform === 'identity') return column
  if (transform === 'year' || transform === 'month' || transform === 'day') {
    return `${column}_${transform}`
  }
  const bucket = transform.match(/^bucket\[(\d+)\]$/)
  if (bucket) return `${column}_bucket_${bucket[1]}`
  const trunc = transform.match(/^truncate\[(\d+)\]$/)
  if (trunc) return `${column}_trunc_${trunc[1]}`
  return `${column}_${transform.replace(/[[\]]/g, '')}`
}

export function describePartitionSpec(config: TableConfig): string {
  const date = `date → ${config.dateTransform}`
  const state = `state → ${stateTransformToIceberg(config.stateTransform)}`
  const sort =
    config.sortFields.length === 0
      ? 'unsorted'
      : config.sortFields.map((f) => `${f.column} ${f.direction}`).join(', ')
  return `${date}, ${state} · sort: ${sort}`
}

export function buildPartitionSpec(config: TableConfig): PartitionSpec {
  const stateIceberg = stateTransformToIceberg(config.stateTransform)
  return {
    'spec-id': 0,
    fields: [
      {
        'source-id': SCHEMA_FIELD_IDS.date,
        'field-id': 1001,
        name: partitionFieldName('date', config.dateTransform),
        transform: config.dateTransform,
      },
      {
        'source-id': SCHEMA_FIELD_IDS.state,
        'field-id': 1002,
        name: partitionFieldName('state', stateIceberg),
        transform: stateIceberg,
      },
    ],
  }
}

export function buildSortOrder(config: TableConfig): SortOrder | undefined {
  if (config.sortFields.length === 0) return undefined
  return {
    'order-id': 0,
    fields: config.sortFields.map((field) => ({
      'source-id': SCHEMA_FIELD_IDS[field.column],
      transform: 'identity',
      direction: field.direction,
      'null-order': 'nulls-last',
    })),
  }
}

export function cloneConfig(config: TableConfig, id: string, name?: string): TableConfig {
  return {
    ...config,
    id,
    name: name ?? config.name,
    stateTransform: { ...config.stateTransform },
    sortFields: config.sortFields.map((f) => ({ ...f })),
  }
}

export function configsMatch(a: TableConfig, b: TableConfig): boolean {
  return (
    a.dateTransform === b.dateTransform &&
    a.stateTransform.kind === b.stateTransform.kind &&
    a.stateTransform.n === b.stateTransform.n &&
    JSON.stringify(a.sortFields) === JSON.stringify(b.sortFields)
  )
}

export function presetIndexForConfig(config: TableConfig): number {
  return TABLE_CONFIG_PRESETS.findIndex((p) => configsMatch(p, config))
}
