// Cut a release that consumers can hold still against.
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
//
// What this checks before cutting is its own suite, and nothing else. A game
// answers for itself: it runs its tests against the version it has pinned and
// takes a new one when those pass. Reaching into somebody else's repo to ask
// permission was slow, and it made this release depend on suites that fail for
// reasons that have nothing to do with the room.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pkgName, tarballName } from './lib/consumers.mjs'

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
const tarball = `releases/${tarballName(version)}`

if (existsSync(join(root, tarball))) {
  console.error(`${tarball} already exists. A released version is not rewritten.`)
  process.exit(1)
}

// Its own suite, before the version exists rather than after.
if (!skipChecks) {
  for (const step of ['typecheck', 'test']) {
    process.stdout.write(`\n── ${step} ${'─'.repeat(Math.max(0, 44 - step.length))}\n`)
    try {
      sh('npm', ['run', '--silent', step], { stdio: 'inherit', encoding: undefined })
    } catch {
      console.error(`\n\`npm run ${step}\` failed. Not releasing.`)
      process.exit(1)
    }
  }
}

manifest.version = version
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

// The tarball ships dist/, so build before packing or it ships the last build.
mkdirSync(join(root, 'releases'), { recursive: true })
sh('npm', ['run', 'build'], { stdio: 'inherit', encoding: undefined })
sh('npm', ['pack', './packages/room', '--pack-destination', 'releases'], { stdio: 'inherit', encoding: undefined })

sh('git', ['add', 'packages/room/package.json', tarball])
sh('git', ['commit', '-m', `Release ${version}`])
sh('git', ['tag', `v${version}`])

console.log(`\nReleased ${version}.`)
console.log(`\nA game takes it with:\n  "${pkgName}": "file:../../../CommonCrane/${tarball}"`)
console.log(`or, for every game at once:\n  npm run pin -- ${version}`)
