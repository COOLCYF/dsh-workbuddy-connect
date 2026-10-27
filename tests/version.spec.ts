import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { WORKBUDDY_CONNECT_VERSION } from '../src/version.ts'

/**
 * Guard the single-source-of-truth version contract:
 * - the build-time define injects package.json's version into src/version.ts;
 * - if that define is ever dropped, version.ts falls back to '0.0.0-dev' and
 *   this test goes red, flagging the regression (and the drift it would cause
 *   in heartbeat / CLI output).
 */
describe('package version sync', () => {
  it('WORKBUDDY_CONNECT_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(WORKBUDDY_CONNECT_VERSION).toBe(pkg.version)
  })

  it('never leaks a build-define fallback marker', () => {
    expect(WORKBUDDY_CONNECT_VERSION).not.toBe('0.0.0-dev')
  })

  /**
   * The define reads package.json at BUILD time, so a release that bumps the
   * version after building ships artifacts reporting the old one (issue #1:
   * v0.2.2 bundles said 0.2.1). Skipped on a fresh clone before the first build.
   *
   * The version literal may land in `index.js` or in a shared chunk beside it
   * (rollup decides which, and the chunk's hashed filename changes with the
   * module graph), so every emitted `.js` is scanned rather than one guessed
   * filename. Searching all of them is what keeps this guard meaningful: the
   * assertion is "the shipped artifacts carry this version", not "the bundle
   * was laid out this way".
   */
  it('built lib/ artifacts carry the current version when present', () => {
    const libDir = new URL('../lib/', import.meta.url)
    if (!existsSync(libDir)) return
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const bundles = readdirSync(libDir).filter(name => name.endsWith('.js'))
    expect(bundles.length, 'no built bundles in lib/ — run the build before this test').toBeGreaterThan(0)
    const declaring = bundles.filter(bundle =>
      readFileSync(new URL(`../lib/${bundle}`, import.meta.url), 'utf8')
        .includes(`WORKBUDDY_CONNECT_VERSION = "${pkg.version}"`),
    )
    expect(
      declaring,
      `no built bundle declares WORKBUDDY_CONNECT_VERSION as "${pkg.version}" — rebuild before committing or publishing`,
    ).not.toHaveLength(0)
  })

  it('built bundles need no runtime import of the atomic-write helper', () => {
    const libDir = new URL('../lib/', import.meta.url)
    if (!existsSync(libDir)) return
    for (const name of readdirSync(libDir).filter(name => name.endsWith('.js'))) {
      const source = readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8')
      expect(source, `${name} still requires the host atomic-write package`)
        .not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*['"]@deepseek-ai\/dsh-atomic-write['"]/)
    }
  })
})

describe('peer manifest pins the verified DSH cores', () => {
  /**
   * #69's lesson: a caret on a prerelease arm (`^0.2.0-rc.1`) silently
   * admits every later rc of the same tuple — semver auto-extends support
   * nobody verified. Up to 0.7.9 the seven DSH service peers were therefore
   * pinned to exactly one core.
   *
   * Since 0.8.0 that changes deliberately, in the opposite direction: the
   * peers are open-ended lower bounds (`>=0.2.1-rc.2`) with **no upper bound**,
   * so a DSH point release such as 0.2.1-rc.3 does not lock the plugin out
   * before anyone can try it. The trade-off is explicit and accepted: an
   * untested future core may break the plugin, and this file can no longer
   * prove otherwise. What it *can* still prove is the shape of the claim —
   * a floor, and no ceiling smuggled in via `^`, `<`, or `||`.
   *
   * #92 and #74's lessons stand unchanged: pi-ai is a pinned regular
   * dependency (never a peer), because a hoisted profile with
   * `autoInstallPeers: false` lets another plugin's older copy win
   * bare-specifier resolution.
   */
  const DSH_SERVICE_PEERS = [
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-settings',
  ] as const

  /** The oldest core this build is meant to serve. */
  const PEER_FLOOR = '>=0.2.1-rc.2'

  it('each DSH service peer is an open-ended floor with no upper bound', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
    for (const name of DSH_SERVICE_PEERS) {
      const range = pkg.peerDependencies[name]
      expect(range, `${name} missing from peerDependencies`).toBe(PEER_FLOOR)
      // Guard the shape: a caret, a `<`, or a `||` arm would quietly reinstate
      // the ceiling this change exists to remove.
      expect(range, `${name} must not carry a caret`).not.toContain('^')
      expect(range, `${name} must not carry an upper bound`).not.toContain('<')
      expect(range, `${name} must not carry a disjunction`).not.toContain('||')
    }
  })

  it('bundles the official atomic-write helper instead of requiring a host peer', () => {
    // The Desktop report could not resolve this peer. Keep the official
    // implementation and include it in lib so runtime resolution is unnecessary.
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string>, devDependencies: Record<string, string> }
    // Pinned to the core the local suite runs against (0.2.1-rc.3).
    expect(pkg.devDependencies['@deepseek-ai/dsh-atomic-write']).toBe('0.2.1-rc.3')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-atomic-write']).toBeUndefined()
  })

  it('pi-ai is a pinned runtime dependency, not a peer', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    // #92's lesson, on top of #74's: a peer declaration cannot survive a
    // hoisted profile. With `nodeLinker: hoisted` and `autoInstallPeers:
    // false`, no install claims our peer, so a co-installed plugin's older
    // pi-ai at the profile root wins bare-specifier resolution and the plugin
    // loads the wrong generation. A regular dependency installs beside the
    // plugin and resolves first, whatever the profile root holds.
    expect(pkg.dependencies?.['@earendil-works/pi-ai']).toBe('1.3.0')
    expect(
      pkg.peerDependencies['@earendil-works/pi-ai'],
      'pi-ai must not also be a peer: a peer declaration is what allowed the hoisted copy to win',
    ).toBeUndefined()
    // The dev entry keeps local builds and tests on the same generation, and
    // stays exact so no caret can widen the supported set by itself.
    expect(pkg.devDependencies['@earendil-works/pi-ai']).toBe('1.3.0')
  })
})
