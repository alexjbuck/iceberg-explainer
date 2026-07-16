import { IcebergExplainer, type PartitionInfo, type TableMetrics } from './explainer.js'
import type { Operation } from './operationLog.js'
import type { TableConfig } from './tableConfig.js'

export type VariantResult = {
  config: TableConfig
  error: string | null
  metrics: TableMetrics | null
  partitions: PartitionInfo[]
  snapshotLabel: string | null
}

async function replayOperation(explainer: IcebergExplainer, op: Operation): Promise<void> {
  switch (op.type) {
    case 'reset':
      await explainer.reset()
      break
    case 'append':
      await explainer.addRow(op.date, op.state, op.value)
      break
    case 'delete':
      await explainer.deleteRow(op.logicalIndex)
      break
    case 'compact':
      await explainer.compact()
      break
  }
}

export async function replayConfig(
  config: TableConfig,
  operations: Operation[],
  snapshotIndex: number,
  tableId: string,
): Promise<VariantResult> {
  const explainer = new IcebergExplainer(config, tableId)
  try {
    for (const op of operations) {
      await replayOperation(explainer, op)
    }
    const clampedIndex = Math.min(
      Math.max(0, snapshotIndex),
      Math.max(0, explainer.listSnapshots().length - 1),
    )
    const snap = explainer.listSnapshots()[clampedIndex]
    return {
      config,
      error: null,
      metrics: explainer.getMetricsAt(clampedIndex),
      partitions: explainer.getPartitions(),
      snapshotLabel: snap?.label ?? null,
    }
  } catch (err) {
    return {
      config,
      error: (err as Error).message,
      metrics: null,
      partitions: [],
      snapshotLabel: null,
    }
  }
}

export async function replayVariants(
  primary: TableConfig,
  variants: TableConfig[],
  operations: Operation[],
  snapshotIndex: number,
): Promise<{ primary: VariantResult; variants: VariantResult[] }> {
  const [primaryResult, ...variantResults] = await Promise.all([
    replayConfig(primary, operations, snapshotIndex, 'primary'),
    ...variants.map((config, i) =>
      replayConfig(config, operations, snapshotIndex, `variant-${i}`),
    ),
  ])
  return { primary: primaryResult, variants: variantResults }
}
