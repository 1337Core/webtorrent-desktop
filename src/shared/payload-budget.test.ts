import { describe, expect, it } from 'vitest'
import { checkPayloadBudget } from './payload-budget'

const budget = {
  maxBytes: 32,
  maxDepth: 3,
  maxNodes: 8
}

describe('checkPayloadBudget', () => {
  it('accepts bounded plain structured-clone data', () => {
    expect(
      checkPayloadBudget({ command: 'ping', payload: [1, true] }, budget)
    ).toMatchObject({ ok: true })
  })

  it('rejects cycles, excess depth, nodes, and bytes', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(checkPayloadBudget(cyclic, budget)).toEqual({
      ok: false,
      reason: 'CYCLE'
    })
    expect(checkPayloadBudget([[[['too deep']]]], budget)).toEqual({
      ok: false,
      reason: 'DEPTH'
    })
    expect(
      checkPayloadBudget(
        Array.from({ length: 9 }, () => 1),
        {
          ...budget,
          maxBytes: 1024
        }
      )
    ).toEqual({
      ok: false,
      reason: 'NODES'
    })
    expect(checkPayloadBudget('x'.repeat(33), budget)).toEqual({
      ok: false,
      reason: 'SIZE'
    })
  })

  it('rejects unsupported structured objects and non-finite numbers', () => {
    expect(checkPayloadBudget(new Date(), budget)).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_VALUE'
    })
    expect(checkPayloadBudget(Number.NaN, budget)).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_VALUE'
    })
  })
})
