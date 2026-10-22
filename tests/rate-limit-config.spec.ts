/**
 * The editable rate-limit config: seeding, hot reload, and the failure posture
 * that keeps a hand-edited typo from either disabling throttling or taking the
 * provider down.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRateLimitReader,
  defaultRateLimitConfig,
  seedRateLimitConfig,
} from '../src/rate-limit-config.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

async function target(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-rate-limit-'))
  cleanup.push(root)
  return join(root, '.workbuddy-rate-limit.json')
}

describe('rate-limit config file', () => {
  it('seeds the defaults once and never overwrites a tuned file', async () => {
    const path = await target()
    expect(seedRateLimitConfig(path)).toBe(true)
    const seeded = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(seeded['minIntervalMs']).toBe(defaultRateLimitConfig().minIntervalMs)

    // A user's tuned values must survive the next start.
    await writeFile(path, JSON.stringify({ ...defaultRateLimitConfig(), minIntervalMs: 4321 }))
    expect(seedRateLimitConfig(path)).toBe(false)
    const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(after['minIntervalMs']).toBe(4321)
  })

  it('reads a valid document', async () => {
    const path = await target()
    await writeFile(path, JSON.stringify({
      enabled: true,
      minIntervalMs: 250,
      jitterMs: 0,
      maxConcurrent: 3,
      cooldownBaseMs: 1000,
      cooldownMaxMs: 5000,
    }))
    const settings = createRateLimitReader({ path }).current()
    expect(settings).toMatchObject({ minIntervalMs: 250, maxConcurrent: 3 })
  })

  it('hot-reloads a saved edit without rebuilding the reader', async () => {
    const path = await target()
    await writeFile(path, JSON.stringify({ ...defaultRateLimitConfig(), minIntervalMs: 100 }))
    const reader = createRateLimitReader({ path })
    expect(reader.current()?.minIntervalMs).toBe(100)

    // Same reader instance, new content: the change must land on the next read.
    await writeFile(path, JSON.stringify({ ...defaultRateLimitConfig(), minIntervalMs: 900 }))
    expect(reader.current()?.minIntervalMs).toBe(900)
  })

  it('reports the gate disabled for enabled: false', async () => {
    const path = await target()
    await writeFile(path, JSON.stringify({ ...defaultRateLimitConfig(), enabled: false }))
    expect(createRateLimitReader({ path }).current()).toBeUndefined()
  })

  it('falls back to the defaults when the document will not parse', async () => {
    const path = await target()
    await writeFile(path, '{ this is not json ')
    const settings = createRateLimitReader({ path }).current()
    expect(settings?.minIntervalMs).toBe(defaultRateLimitConfig().minIntervalMs)
  })

  it('normalises bad field values instead of trusting or failing on them', async () => {
    const path = await target()
    await writeFile(path, JSON.stringify({
      // A string where a number belongs, a negative count, and a ceiling below
      // the base: each must resolve to something usable.
      minIntervalMs: 'fast',
      maxConcurrent: -3,
      cooldownBaseMs: 900,
      cooldownMaxMs: 100,
    }))
    const settings = createRateLimitReader({ path }).current()
    const defaults = defaultRateLimitConfig()
    expect(settings?.minIntervalMs).toBe(defaults.minIntervalMs)
    expect(settings?.maxConcurrent).toBe(defaults.maxConcurrent)
    // The ceiling is lifted to the base rather than the base being clamped.
    expect(settings?.cooldownMaxMs).toBe(900)
  })

  it('ignores the //-prefixed documentation keys', async () => {
    const path = await target()
    await writeFile(path, JSON.stringify({
      '//': 'explanation',
      '//minIntervalMs': 'not a value, just prose',
      ...defaultRateLimitConfig(),
    }))
    expect(createRateLimitReader({ path }).current()?.minIntervalMs)
      .toBe(defaultRateLimitConfig().minIntervalMs)
  })
})
