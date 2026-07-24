export type PayloadBudget = {
  maxBytes: number
  maxDepth: number
  maxNodes: number
}

export type PayloadBudgetResult =
  | { ok: true; bytes: number; nodes: number }
  | {
      ok: false
      reason: 'CYCLE' | 'DEPTH' | 'NODES' | 'SIZE' | 'UNSUPPORTED_VALUE'
    }

type PayloadBudgetFailureReason = Extract<
  PayloadBudgetResult,
  { ok: false }
>['reason']

export function checkPayloadBudget(
  value: unknown,
  budget: PayloadBudget
): PayloadBudgetResult {
  const seen = new WeakSet<object>()
  let bytes = 0
  let nodes = 0

  const visit = (
    candidate: unknown,
    depth: number
  ): PayloadBudgetFailureReason | null => {
    if (depth > budget.maxDepth) return 'DEPTH'
    nodes += 1
    if (nodes > budget.maxNodes) return 'NODES'

    switch (typeof candidate) {
      case 'string':
        bytes += new TextEncoder().encode(candidate).byteLength
        break
      case 'number':
        if (!Number.isFinite(candidate)) return 'UNSUPPORTED_VALUE'
        bytes += 8
        break
      case 'boolean':
        bytes += 1
        break
      case 'object':
        if (candidate === null) {
          bytes += 1
          break
        }
        if (seen.has(candidate)) return 'CYCLE'
        seen.add(candidate)

        if (Array.isArray(candidate)) {
          for (const entry of candidate) {
            const reason = visit(entry, depth + 1)
            if (reason) return reason
          }
          break
        }

        if (
          Object.getPrototypeOf(candidate) !== Object.prototype &&
          Object.getPrototypeOf(candidate) !== null
        ) {
          return 'UNSUPPORTED_VALUE'
        }
        for (const [key, entry] of Object.entries(candidate)) {
          bytes += new TextEncoder().encode(key).byteLength
          const reason = visit(entry, depth + 1)
          if (reason) return reason
        }
        break
      default:
        return 'UNSUPPORTED_VALUE'
    }

    return bytes > budget.maxBytes ? 'SIZE' : null
  }

  const reason = visit(value, 0)
  return reason ? { ok: false, reason } : { ok: true, bytes, nodes }
}
