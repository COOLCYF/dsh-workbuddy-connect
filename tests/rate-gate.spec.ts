/**
 * The upstream request gate: spacing, concurrency, adaptive cooldown.
 *
 * These pin the behaviour that the measured 429 burst made necessary, and each
 * one failed at least once during development — the spacing case in particular
 * passed only after the scheduling step was serialised, because concurrent
 * callers previously all computed the same delay and then started together.
 */
import { describe, expect, it } from 'vitest'
import { createUpstreamGate, type RateLimitSettings } from '../src/rate-gate.ts'

const FAST: RateLimitSettings = {
  minIntervalMs: 0,
  jitterMs: 0,
  maxConcurrent: 4,
  cooldownBaseMs: 100,
  cooldownMaxMs: 400,
}

function fixed(settings: RateLimitSettings) {
  return createUpstreamGate({ current: () => settings })
}

/** Collect the start timestamps of N gated calls, in call order. */
async function starts(
  gate: ReturnType<typeof createUpstreamGate>,
  count: number,
  work: () => Promise<void> = async () => {},
): Promise<number[]> {
  const seen: number[] = []
  await Promise.all(
    Array.from({ length: count }, () =>
      gate.run(async () => {
        seen.push(Date.now())
        await work()
      }),
    ),
  )
  return seen
}

describe('upstream request gate', () => {
  it('holds each request at least the minimum interval apart', async () => {
    const gate = fixed({ ...FAST, minIntervalMs: 120 })
    const t0 = Date.now()
    const seen = (await starts(gate, 3)).map(at => at - t0).sort((a, b) => a - b)
    const gaps = [seen[1]! - seen[0]!, seen[2]! - seen[1]!]
    // Concurrency is not the limit here, so this isolates spacing: without the
    // serialised scheduler both gaps measure 0.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(100)
  })

  it('never exceeds maxConcurrent upstream streams', async () => {
    const gate = fixed({ ...FAST, maxConcurrent: 2 })
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 8 }, () =>
        gate.run(async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise(resolve => setTimeout(resolve, 20))
          active -= 1
        }),
      ),
    )
    expect(peak).toBe(2)
  })

  it('doubles the cooldown per busy answer and caps it', () => {
    const gate = fixed({ ...FAST, cooldownBaseMs: 100, cooldownMaxMs: 400 })
    expect(gate.noteRateLimited()).toBe(100)
    expect(gate.noteRateLimited()).toBe(200)
    expect(gate.noteRateLimited()).toBe(400)
    // Already at the ceiling: stays there rather than overflowing.
    expect(gate.noteRateLimited()).toBe(400)
  })

  it('clears the penalty after a success', () => {
    const gate = fixed(FAST)
    gate.noteRateLimited()
    expect(gate.state().penaltyMs).toBeGreaterThan(0)
    gate.noteSuccess()
    expect(gate.state().penaltyMs).toBe(0)
  })

  it('actually delays the next request while a cooldown is active', async () => {
    const gate = fixed({ ...FAST, minIntervalMs: 0, cooldownBaseMs: 150, cooldownMaxMs: 150 })
    gate.noteRateLimited()
    const before = Date.now()
    await gate.run(async () => {})
    expect(Date.now() - before).toBeGreaterThanOrEqual(120)
  })

  it('releases a queued waiter when its caller aborts', async () => {
    const gate = fixed({ ...FAST, maxConcurrent: 1 })
    const controller = new AbortController()
    const holding = gate.run(() => new Promise<void>(resolve => setTimeout(resolve, 60)))
    const queued = gate.run(async () => {}, controller.signal)
    controller.abort()
    await expect(queued).rejects.toThrow(/aborted/)
    await holding
    // The aborted waiter must not leave the slot taken.
    expect(gate.state().active).toBe(0)
    expect(gate.state().queued).toBe(0)
  })

  it('applies a settings change on the next request without rebuilding', async () => {
    let settings: RateLimitSettings = { ...FAST, minIntervalMs: 0 }
    const gate = createUpstreamGate({ current: () => settings })
    settings = { ...FAST, minIntervalMs: 120 }
    const t0 = Date.now()
    const seen = (await starts(gate, 2)).map(at => at - t0).sort((a, b) => a - b)
    expect(seen[1]! - seen[0]!).toBeGreaterThanOrEqual(100)
  })

  it('treats a disabled source as no spacing and no concurrency bound', async () => {
    let enabled = true
    const gate = createUpstreamGate({ current: () => (enabled ? { ...FAST, minIntervalMs: 200, maxConcurrent: 1 } : undefined) })
    enabled = false
    const t0 = Date.now()
    const seen = (await starts(gate, 4)).map(at => at - t0)
    // Every call started essentially at once, and none waited on a slot.
    expect(Math.max(...seen) - Math.min(...seen)).toBeLessThan(100)
    expect(gate.state().penaltyMs).toBe(0)
  })
})
