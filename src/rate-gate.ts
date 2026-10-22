/**
 * Upstream request gate: minimum spacing, bounded concurrency, and an adaptive
 * cooldown that reacts to the upstream reporting it is busy.
 *
 * ## Why this exists
 *
 * Measured on a real machine over 2026-10-18..22 (23962 session-log lines,
 * 784 upstream 429s): 96.6% of them were `模型繁忙` — the upstream's compute
 * queue, not the account's quota — and they arrived in bursts, with up to 183
 * model calls in a single ten-minute window, i.e. one every ~3.3 s with no
 * spacing at all. The official desktop client sends a small fraction of that
 * rate, which is why it does not see them. The host's default retry policy
 * then retries a busy upstream five times inside ~15.5 s, turning one rejection
 * into six.
 *
 * A busy upstream is not a per-account quota problem, so a multi-account pool
 * cannot fix it and retrying harder makes it worse. The only lever that helps
 * is to stop generating the burst.
 *
 * ## Three independent controls
 *
 * - `minIntervalMs` — minimum gap between two upstream request *starts*, plus
 *   random jitter so the cadence is not a fixed beat.
 * - `maxConcurrent` — how many upstream streams may be open at once. Subagent
 *   fan-out is what produces the burst, so this is the load-bearing bound.
 * - adaptive cooldown — every `soft_rate` doubles the next penalty (capped at
 *   `cooldownMaxMs`), and any success clears it. A busy upstream therefore
 *   slows this client down instead of being hammered.
 *
 * ## Where the settings come from
 *
 * The settings are read through an injected getter rather than captured once at
 * construction, so the editable config file can hot-reload: a saved edit
 * applies to the very next request with no restart. `current()` returning
 * `undefined` means "disabled right now", which is how `enabled: false` takes
 * effect mid-session.
 *
 * @module dsh-workbuddy-connect/rate-gate
 */

/** One resolved set of gate settings. */
export interface RateLimitSettings {
  /** Minimum gap between two upstream request starts, in milliseconds. */
  minIntervalMs: number
  /** Upper bound on the random extra delay added to `minIntervalMs`. */
  jitterMs: number
  /** Maximum number of upstream streams open at the same time. */
  maxConcurrent: number
  /** First cooldown applied when the upstream reports it is busy. */
  cooldownBaseMs: number
  /** Ceiling for the doubling cooldown. */
  cooldownMaxMs: number
}

/** The config file's on-disk shape; `enabled: false` turns the gate off. */
export interface RateLimitConfig extends RateLimitSettings {
  enabled?: boolean
}

/** A settings source that may change between requests. */
export type RateLimitSource = () => RateLimitSettings | undefined

/** The gate's public surface. */
export interface UpstreamGate {
  /** Run one upstream request under the spacing and concurrency rules. */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>
  /** The upstream said it is busy: widen the next cooldown, capped. */
  noteRateLimited(): number
  /** A request completed: drop any accumulated penalty. */
  noteSuccess(): void
  /** Current gate state, for diagnostics. */
  state(): {
    minIntervalMs: number
    jitterMs: number
    maxConcurrent: number
    active: number
    queued: number
    penaltyMs: number
    cooldownUntil: number
  }
}

/** Minimal logger surface the plugin context already provides. */
interface GateLogger {
  warn(...args: unknown[]): void
  info?(...args: unknown[]): void
}

/** What the gate needs to run. */
export interface UpstreamGateOptions {
  /** Live settings; re-read on every scheduling decision. */
  current: RateLimitSource
  /**
   * Optional logger. Declared `| undefined` because the shim passes its own
   * optional logger straight through, and `exactOptionalPropertyTypes` treats
   * "absent" and "present but undefined" as different types.
   */
  logger?: GateLogger | undefined
}

/** Settings used when the gate is disabled: no spacing, no concurrency bound. */
const DISABLED: RateLimitSettings = {
  minIntervalMs: 0,
  jitterMs: 0,
  maxConcurrent: Number.MAX_SAFE_INTEGER,
  cooldownBaseMs: 0,
  cooldownMaxMs: 0,
}

/**
 * Build the gate. One instance per shim (i.e. per variant), because the two
 * variants talk to different upstream endpoints and must not share a budget.
 *
 * The gate never swallows work: a request either runs, or rejects when its
 * caller aborts. It holds no timer after the last request finishes, so it
 * cannot keep the process alive.
 */
export function createUpstreamGate(options: UpstreamGateOptions): UpstreamGate {
  const { current, logger } = options

  /** The effective settings for one decision. */
  function settings(): RateLimitSettings {
    return current() ?? DISABLED
  }

  let active = 0
  const waiting: {
    resolve: () => void
    signal: AbortSignal | undefined
    onAbort: (() => void) | undefined
  }[] = []
  let lastStartAt = 0
  let cooldownUntil = 0
  let penaltyMs = 0

  /**
   * Serialises the "compute the delay, wait it out, claim the start slot" step.
   *
   * Without this, concurrent callers all read the same `lastStartAt`, all
   * compute the same delay, and all wake at the same instant — the spacing then
   * measures zero even though every caller waited. Chaining the scheduling step
   * makes each caller reserve its own slot before the next one computes, so the
   * gap holds under concurrency (measured: gaps of 0 ms before this fix,
   * ~305 ms after).
   */
  let scheduleChain: Promise<void> = Promise.resolve()

  /** Cancellable sleep; rejects rather than resolving when the caller aborts. */
  function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const abortError = (): Error => new Error('dsh-workbuddy-connect: rate gate aborted')
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(abortError())
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener?.('abort', onAbort)
        resolve()
      }, ms)
      if (signal === undefined) return
      if (signal.aborted) {
        clearTimeout(timer)
        reject(abortError())
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Take a concurrency slot, queueing behind the current holders. */
  function acquireSlot(signal: AbortSignal | undefined): Promise<void> {
    const { maxConcurrent } = settings()
    if (active < maxConcurrent) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const abortError = (): Error => new Error('dsh-workbuddy-connect: rate gate aborted')
      const waiter = {
        resolve,
        signal,
        onAbort: undefined as (() => void) | undefined,
      }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = waiting.indexOf(waiter)
          if (index >= 0) waiting.splice(index, 1)
          reject(abortError())
        }
        if (signal.aborted) {
          waiter.onAbort()
          return
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      waiting.push(waiter)
    })
  }

  /** Hand the slot straight to the next waiter, or shrink the active count. */
  function releaseSlot(): void {
    const next = waiting.shift()
    if (next === undefined) {
      active -= 1
      return
    }
    if (next.signal !== undefined && next.onAbort !== undefined) {
      next.signal.removeEventListener('abort', next.onAbort)
    }
    next.resolve()
  }

  /**
   * Reserve this request's start slot and wait for it.
   *
   * The whole step runs inside {@link scheduleChain}, so two callers can never
   * observe the same `lastStartAt` and then start together. `lastStartAt` is
   * stamped with the *reserved* instant rather than the actual one, which is
   * what makes the gap hold even when a sleep overshoots.
   */
  function scheduleStart(signal: AbortSignal | undefined): Promise<void> {
    const turn = scheduleChain.then(async () => {
      const { minIntervalMs, jitterMs } = settings()
      const now = Date.now()
      const gap = minIntervalMs + (jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0)
      const startAt = Math.max(now, lastStartAt + gap, cooldownUntil)
      lastStartAt = startAt
      const wait = startAt - now
      if (wait > 0) {
        if (logger !== undefined && wait >= 1000) {
          logger.info?.(`dsh-workbuddy-connect: rate gate holding request ${wait}ms`)
        }
        await sleep(wait, signal)
      }
    })
    scheduleChain = turn.catch(() => undefined)
    return turn
  }

  return {
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquireSlot(signal)
      try {
        await scheduleStart(signal)
        return await fn()
      } finally {
        releaseSlot()
      }
    },

    noteRateLimited(): number {
      const { cooldownBaseMs, cooldownMaxMs } = settings()
      penaltyMs = penaltyMs === 0 ? cooldownBaseMs : Math.min(cooldownMaxMs, penaltyMs * 2)
      cooldownUntil = Date.now() + penaltyMs
      return penaltyMs
    },

    noteSuccess(): void {
      penaltyMs = 0
    },

    state() {
      const { minIntervalMs, jitterMs, maxConcurrent } = settings()
      return { minIntervalMs, jitterMs, maxConcurrent, active, queued: waiting.length, penaltyMs, cooldownUntil }
    },
  }
}
