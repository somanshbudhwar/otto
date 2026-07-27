import { app } from 'electron'
import type { UpdateInfo } from '@shared/types'

/**
 * Update notification against GitHub Releases.
 *
 * Otto ships unsigned, so it cannot install updates in place — Squirrel.Mac
 * refuses to swap an app bundle it can't verify a Developer ID signature on.
 * Instead we poll the releases API and point the user at the right .dmg. If
 * Otto is ever signed and notarised, this module is the thing to replace with
 * electron-updater.
 */

/** Must match the repository the release workflow publishes to. */
const REPO = 'somanshbudhwar/otto'
const LATEST_RELEASE = `https://api.github.com/repos/${REPO}/releases/latest`

/** Unauthenticated GitHub API allows 60 calls/hour; this is far under it. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Let the window mount its listener before the first check lands. */
const FIRST_CHECK_DELAY_MS = 8_000
const REQUEST_TIMEOUT_MS = 10_000

interface GithubAsset {
  name: string
  browser_download_url: string
}

interface GithubRelease {
  tag_name: string
  html_url: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
  assets?: GithubAsset[]
}

/** [major, minor, patch]; missing or non-numeric segments read as 0. */
function parseVersion(raw: string): [number, number, number] {
  const core = raw.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? ''
  const parts = core.split('.').map((n) => Number.parseInt(n, 10))
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/**
 * Prefer the build for this machine's architecture. Under Rosetta `process.arch`
 * reports x64, which is also the right download there.
 */
function pickAsset(assets: GithubAsset[]): string | undefined {
  const dmgs = assets.filter((a) => a.name.toLowerCase().endsWith('.dmg'))
  const forArch = dmgs.find((a) => a.name.includes(`-${process.arch}.`))
  return (forArch ?? dmgs[0])?.browser_download_url
}

async function fetchLatest(): Promise<UpdateInfo | null> {
  const response = await fetch(LATEST_RELEASE, {
    headers: {
      Accept: 'application/vnd.github+json',
      // GitHub rejects API requests that omit a User-Agent.
      'User-Agent': `Otto/${app.getVersion()}`
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) return null

  const release = (await response.json()) as GithubRelease
  if (release.draft || release.prerelease) return null

  const version = release.tag_name.replace(/^v/i, '')
  const currentVersion = app.getVersion()
  if (!isNewer(version, currentVersion)) return null

  return {
    version,
    currentVersion,
    downloadUrl: pickAsset(release.assets ?? []) ?? release.html_url,
    releaseUrl: release.html_url,
    notes: release.body?.trim() || undefined,
    publishedAt: release.published_at ? Date.parse(release.published_at) : undefined
  }
}

/** Resolves to null when up to date, offline, rate-limited, or running in dev. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // A dev run reports the package.json version and has no bundle to replace.
  if (!app.isPackaged) return null
  try {
    return await fetchLatest()
  } catch {
    return null
  }
}

/**
 * Checks shortly after launch and every few hours after. Returns a stop
 * function so the timers don't outlive the app on quit.
 */
export function startUpdateWatcher(
  onUpdate: (info: UpdateInfo) => void,
  isSkipped: (version: string) => boolean
): () => void {
  let stopped = false

  const run = async (): Promise<void> => {
    const info = await checkForUpdate()
    if (!stopped && info && !isSkipped(info.version)) onUpdate(info)
  }

  const first = setTimeout(() => void run(), FIRST_CHECK_DELAY_MS)
  const repeat = setInterval(() => void run(), CHECK_INTERVAL_MS)

  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(repeat)
  }
}
