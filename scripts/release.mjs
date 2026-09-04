// Cut a release of @cc/room that consumers can hold still against.
//
// The library used to be a symlink: an edit here was in every game the moment
// it was saved, whether that game was ready for it or not. A release breaks
// that by making a copy — `npm pack` writes a tarball into releases/, npm
// unpacks tarballs rather than linking them, and so a game that names one is
// frozen at it until somebody changes the string. The working copy in
// packages/room is then free to be whatever comes next.
//
// The tarball is committed. It is the artifact, and a version that only exists
// on the machine that cut it is not a version anybody else can install.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'packages/room/package.json')

const args = process.argv.slice(2)
const skipChecks = args.includes('--skip-checks')
const bump = args.find((a) => !a.startsWith('--'))

if (!bump) {
  console.error('usage: npm run release -- <major|minor|patch|x.y.z> [--skip-checks]')
  process.exit(2)
}

const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', ...opts })

/** A release names a commit, so refuse to cut one from a tree nobody can name. */
const dirty = sh('git', ['status', '--porcelain']).trim()
if (dirty) {
  console.error('Working tree is not clean. Commit or stash first:\n' + dirty)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const current = manifest.version

/** Either an explicit version, or the next one along from where we are. */
function next(from, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how
  const [major, minor, patch] = from.split('.').map(Number)
  if (how === 'major') return `${major + 1}.0.0`
  if (how === 'minor') return `${major}.${minor + 1}.0`
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`
  console.error(`Don't know how to bump by "${how}".`)
  process.exit(2)
}

const version = next(current, bump)
const tarball = `releases/cc-room-${version}.tgz`

if (existsSync(join(root, tarball))) {
  console.error(`${tarball} already exists. A released version is not rewritten.`)
  process.exit(1)
}

// The games are the only suite that would notice a break, so ask them before
// the version exists rather than after it is in their manifests.
//
// But a game's suite is red for its own reasons — a bot test that times out
// has nothing to say about the room — and a gate that stops for those is a
// gate nobody leaves switched on. So each release records how the games stood
// when it was cut, and the next one blocks only on a check that was passing
// then and is failing now. Weather is reported; a regression stops the
// release.

/** How the games stood at the most recent release, if there has been one. */
function lastBaseline() {
  const dir = join(root, 'releases')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith('.checks.json'))
  if (files.length === 0) return null
  const versionOf = (f) => f.match(/cc-room-(.+)\.checks\.json$/)?.[1] ?? '0.0.0'
  const rank = (v) => v.split('.').map(Number).reduce((a, n) => a * 10000 + n, 0)
  const newest = files.sort((a, b) => rank(versionOf(a)) - rank(versionOf(b))).at(-1)
  return { version: versionOf(newest), checks: JSON.parse(readFileSync(join(dir, newest), 'utf8')) }
}

const checksPath = join(root, 'releases', `cc-room-${version}.checks.json`)
mkdirSync(join(root, 'releases'), { recursive: true })

if (!skipChecks) {
  console.log(`Checking the consumers against this working copy before releasing ${version}…\n`)
  try {
    sh('node', [join(root, 'scripts/consumers.mjs'), '--json', checksPath], { stdio: 'inherit', encoding: undefined })
  } catch {
    // A red check is not by itself a reason to stop; the comparison below decides.
  }

  if (!existsSync(checksPath)) {
    console.error('The consumer run produced no results. Not releasing.')
    process.exit(1)
  }

  const results = JSON.parse(readFileSync(checksPath, 'utf8'))
  const baseline = lastBaseline()
  const failing = results.filter((r) => !r.ok)

  const wasPassing = (r) =>
    baseline?.checks.some((b) => b.name === r.name && b.step === r.step && b.ok) ?? false
  const regressions = failing.filter(wasPassing)

  if (failing.length > 0) {
    console.log(
      baseline
        ? `\n${failing.length} check(s) red; ${failing.length - regressions.length} were already red at ${baseline.version}.`
        : `\n${failing.length} check(s) red. No earlier release to compare against, so this run becomes the baseline.`,
    )
    for (const r of failing) console.log(`  ${wasPassing(r) ? 'REGRESSED' : 'already red'}  ${r.name} · ${r.step}`)
  }

  if (regressions.length > 0) {
    console.error(`\nThese passed at ${baseline.version} and fail against this working copy. Not releasing.`)
    console.error('Fix them, or pass --skip-checks if this release is meant to break them.')
    rmSync(checksPath, { force: true })
    process.exit(1)
  }
}

manifest.version = version
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

sh('npm', ['pack', './packages/room', '--pack-destination', 'releases'], { stdio: 'inherit', encoding: undefined })

const toCommit = ['packages/room/package.json', tarball]
if (existsSync(checksPath)) toCommit.push(`releases/cc-room-${version}.checks.json`)
sh('git', ['add', ...toCommit])
sh('git', ['commit', '-m', `Release ${version}`])
sh('git', ['tag', `v${version}`])

console.log(`\nReleased ${version}.`)
console.log(`\nA game takes it with:\n  "@cc/room": "file:../../../CommonCrane/${tarball}"`)
console.log(`or, for every game at once:\n  npm run pin -- ${version}`)
