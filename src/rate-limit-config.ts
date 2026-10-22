/**
 * The editable, hot-reloading rate-limit config.
 *
 * The gate's settings live in one JSON document beside the plugin's other
 * per-user state files, so a user tunes throttling by editing that file instead
 * of patching `lib/` or exporting environment variables. The file is re-read on
 * demand and re-parsed only when its mtime or size changes, so a saved edit
 * applies to the next request with no DSH restart.
 *
 * ## Precedence
 *
 * The config file wins when it exists — it is the surface the user edits. When
 * it does not exist, the environment variables documented in the README apply,
 * and failing those the compiled-in defaults. That order keeps one obvious
 * source of truth while preserving the env overrides for anyone who never
 * creates the file.
 *
 * ## Failure posture
 *
 * A hand-edited config goes wrong in predictable ways: a trailing comma, a
 * number quoted as a string, a negative value, a typo'd key. None of them may
 * silently disable throttling, and none may take the provider down either. So
 * every field falls back to its default independently, and a document that will
 * not parse at all yields the defaults plus one warning.
 *
 * @module dsh-workbuddy-connect/rate-limit-config
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { RateLimitConfig, RateLimitSettings } from './rate-gate.ts'

/** Basename of the editable rate-limit config inside the Harness home. */
export const RATE_LIMIT_CONFIG_FILENAME = '.workbuddy-rate-limit.json'

/** Minimal logger surface the plugin context already provides. */
interface ConfigLogger {
  warn(...args: unknown[]): void
  info?(...args: unknown[]): void
}

/** What the reader needs. */
export interface RateLimitReaderOptions {
  /** Config document path; defaults to the Harness home. */
  path?: string | undefined
  /**
   * Optional logger. Declared `| undefined` because the shim passes its own
   * optional logger straight through, and `exactOptionalPropertyTypes` treats
   * "absent" and "present but undefined" as different types.
   */
  logger?: ConfigLogger | undefined
}

/** The reader's public surface. */
export interface RateLimitReader {
  /** The path the user edits, for diagnostics and the settings card. */
  path: string
  /**
   * The effective settings, or `undefined` when the gate is disabled right now.
   * Re-reads the file when it changed, so callers may invoke this per request.
   */
  current(): RateLimitSettings | undefined
}

/** The compiled-in defaults, shared with the file seeder. */
export function defaultRateLimitConfig(): Required<RateLimitConfig> {
  return {
    enabled: true,
    minIntervalMs: 1200,
    jitterMs: 400,
    maxConcurrent: 2,
    cooldownBaseMs: 5000,
    cooldownMaxMs: 120_000,
  }
}

/** The config document's path inside the Harness home. */
export function workbuddyRateLimitPath(): string {
  return join(resolveDshHome(), RATE_LIMIT_CONFIG_FILENAME)
}

/** Read a non-negative-integer env override, falling back to the default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

/**
 * The environment-variable path, used only when no config file exists.
 *
 * `DSH_WORKBUDDY_RATE_LIMIT=0` disables the gate outright; otherwise each knob
 * has its own override so an existing deployment keeps working unchanged.
 */
export function rateLimitFromEnv(): RateLimitSettings | undefined {
  if (String(process.env['DSH_WORKBUDDY_RATE_LIMIT'] ?? '').trim() === '0') return undefined
  const defaults = defaultRateLimitConfig()
  return {
    minIntervalMs: envInt('DSH_WORKBUDDY_MIN_INTERVAL_MS', defaults.minIntervalMs),
    jitterMs: envInt('DSH_WORKBUDDY_RATE_JITTER_MS', defaults.jitterMs),
    maxConcurrent: Math.max(1, envInt('DSH_WORKBUDDY_MAX_CONCURRENT', defaults.maxConcurrent)),
    cooldownBaseMs: envInt('DSH_WORKBUDDY_COOLDOWN_BASE_MS', defaults.cooldownBaseMs),
    cooldownMaxMs: envInt('DSH_WORKBUDDY_COOLDOWN_MAX_MS', defaults.cooldownMaxMs),
  }
}

/**
 * Normalise one numeric field of a hand-edited document.
 *
 * Anything that is not a finite number at or above `minimum` falls back to the
 * default rather than failing the whole gate: one typo must not be able to turn
 * throttling off silently.
 */
function configInt(source: Record<string, unknown>, key: string, fallback: number, minimum: number): number {
  const raw = source[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  if (raw < minimum) return fallback
  return Math.floor(raw)
}

/**
 * Build the reader. The parsed document is cached against its mtime+size, so
 * the steady-state cost of a request is one `stat`, not a parse.
 */
export function createRateLimitReader(options: RateLimitReaderOptions = {}): RateLimitReader {
  const path = options.path ?? workbuddyRateLimitPath()
  const logger = options.logger

  let cached: RateLimitConfig | undefined
  let cachedStamp: string | undefined
  let warnedMissing = false

  /** Parse the document when it changed; `undefined` when it is absent. */
  function readFileConfig(): RateLimitConfig | undefined {
    let stat
    try {
      stat = statSync(path)
    } catch {
      return undefined
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (cachedStamp === stamp) return cached

    cachedStamp = stamp
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error: unknown) {
      logger?.warn(
        `dsh-workbuddy-connect: rate-limit config is not valid JSON; using defaults (${path})`,
        error,
      )
      cached = defaultRateLimitConfig()
      return cached
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger?.warn(
        `dsh-workbuddy-connect: rate-limit config must be a JSON object; using defaults (${path})`,
      )
      cached = defaultRateLimitConfig()
      return cached
    }

    const source = parsed as Record<string, unknown>
    const defaults = defaultRateLimitConfig()
    // Comment keys (`//…`) are ignored by construction: only known names are read.
    const enabled = source['enabled'] !== false
    const next: RateLimitConfig = {
      enabled,
      minIntervalMs: configInt(source, 'minIntervalMs', defaults.minIntervalMs, 0),
      jitterMs: configInt(source, 'jitterMs', defaults.jitterMs, 0),
      maxConcurrent: Math.max(1, configInt(source, 'maxConcurrent', defaults.maxConcurrent, 1)),
      cooldownBaseMs: configInt(source, 'cooldownBaseMs', defaults.cooldownBaseMs, 0),
      cooldownMaxMs: configInt(source, 'cooldownMaxMs', defaults.cooldownMaxMs, 0),
    }
    // A ceiling below the base would make the first penalty already exceed it;
    // lift the ceiling instead of silently clamping the base.
    if (next.cooldownBaseMs > next.cooldownMaxMs) next.cooldownMaxMs = next.cooldownBaseMs
    cached = next
    logger?.info?.(`dsh-workbuddy-connect: rate-limit config reloaded (${path})`)
    return cached
  }

  return {
    path,
    current(): RateLimitSettings | undefined {
      const fromFile = readFileConfig()
      if (fromFile !== undefined) {
        if (fromFile.enabled === false) return undefined
        return fromFile
      }
      if (!warnedMissing) {
        warnedMissing = true
        logger?.info?.(
          `dsh-workbuddy-connect: no rate-limit config at ${path}; using env/defaults`,
        )
      }
      return rateLimitFromEnv()
    },
  }
}

/**
 * Write the default document when none exists, so there is something to edit.
 *
 * Seeded once, never overwritten: a user's tuned values must survive restarts.
 * The `//`-prefixed keys are documentation — JSON has no comments, and the
 * reader ignores unknown keys, so they are inert.
 *
 * @returns whether a file was written.
 */
export function seedRateLimitConfig(path: string): boolean {
  try {
    if (existsSync(path)) return false
    const defaults = defaultRateLimitConfig()
    const document: Record<string, unknown> = {
      '//': 'WorkBuddy 限速配置。改完保存即可，下一次请求自动生效，无需重启 DSH。',
      '//enabled': 'false 表示完全关闭限速（不推荐）。',
      '//minIntervalMs': '两次上游请求的最小间隔（毫秒）。越小越快，越容易撞「模型繁忙」。',
      '//jitterMs': '在最小间隔之上再加的随机抖动上限（毫秒），避免固定节奏。',
      '//maxConcurrent': '同时进行的上游请求数上限。子代理并发是突发主因，调小更稳。',
      '//cooldownBaseMs': '上游返回繁忙后的首次冷却时长（毫秒）。',
      '//cooldownMaxMs': '冷却时长翻倍增长的上限（毫秒）。',
      ...defaults,
    }
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
