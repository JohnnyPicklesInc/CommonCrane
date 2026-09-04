// Move the games onto a released version of @cc/room.
//
// The manifests all say the same thing in the same shape, and there are ten of
// them across five repos, so this rewrites them rather than asking anybody to.
// Naming no repo moves all of them; naming some moves only those, which is how
// one game takes a new version early while the rest stay where they are.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findConsumers, knownNames, pkgName, root, tarballName, workspace } from './lib/consumers.mjs'

const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('--'))
const only = args.filter((a) => !a.startsWith('--') && a !== version)
const dryRun = args.includes('--dry-run')

if (!version) {
  console.error('usage: npm run pin -- <version> [repo…] [--dry-run]')
  process.exit(2)
}

const tarball = join(root, 'releases', tarballName(version))
if (!existsSync(tarball)) {
  console.error(`No release ${version}. Cut one with: npm run release -- <major|minor|patch|x.y.z>`)
  process.exit(1)
}

const consumers = findConsumers().filter((c) => only.length === 0 || only.includes(c.name))
if (consumers.length === 0) {
  console.error(only.length > 0 ? `No consumer named ${only.join(', ')}.` : 'No consumers found.')
  process.exit(1)
}

const touched = []
for (const { repo, name, manifests } of consumers) {
  let changed = false
  for (const path of manifests) {
    const text = readFileSync(path, 'utf8')
    const manifest = JSON.parse(text)
    // The path is relative to the manifest's own directory, which is how npm
    // reads a file: dependency — one repo nests a package deeper than another.
    const spec = `file:${relative(join(path, '..'), tarball)}`
    let touchedHere = false
    for (const field of ['dependencies', 'devDependencies']) {
      const deps = manifest[field]
      if (!deps) continue
      // A repo may still be on an old name, so move it across as well as up.
      for (const old of knownNames.filter((n) => n !== pkgName)) {
        if (deps[old] !== undefined) {
          delete deps[old]
          deps[pkgName] = spec
          touchedHere = true
        }
      }
      if (deps[pkgName] !== undefined && deps[pkgName] !== spec) {
        deps[pkgName] = spec
        touchedHere = true
      }
    }
    if (!touchedHere) continue
    console.log(`${dryRun ? 'would pin' : 'pin'} ${path.slice(workspace.length + 1)} → ${spec}`)
    if (!dryRun) writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
    changed = true
  }
  if (changed) touched.push({ repo, name })
}

if (touched.length === 0) {
  console.log(`Every consumer already names ${version}. Nothing to do.`)
  process.exit(0)
}

if (dryRun) process.exit(0)

// A manifest that says one thing while node_modules holds another is worse
// than either, so install rather than leaving it to be noticed later.
for (const { repo, name } of touched) {
  console.log(`\n── ${name} · npm install ─────────────────────────`)
  execFileSync('npm', ['install'], { cwd: repo, stdio: 'inherit' })
}

console.log(`\n${touched.length} repo(s) now on ${pkgName} ${version}.`)
