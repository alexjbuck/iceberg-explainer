export type Operation =
  | { type: 'reset' }
  | { type: 'append'; date: string; state: string; value: string }
  | { type: 'delete'; logicalIndex: number }
  | { type: 'compact' }

export class OperationLog {
  private ops: Operation[] = []

  reset(): void {
    this.ops = [{ type: 'reset' }]
  }

  append(op: Operation): void {
    this.ops.push(op)
  }

  getOperations(): Operation[] {
    return [...this.ops]
  }

  describe(): string {
    const labels = this.ops.map((op) => {
      switch (op.type) {
        case 'reset':
          return 'reset'
        case 'append':
          return `+row(${op.date}, ${op.state})`
        case 'delete':
          return `-row(#${op.logicalIndex})`
        case 'compact':
          return 'compact'
      }
    })
    return labels.join(' → ')
  }
}
