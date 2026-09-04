// Who depends on us, and where they keep the copy they depend on.
//
// Discovered rather than listed, by the same rule throughout: a repo beside
// this one is a consumer if any manifest in it names an @cc/ package. A fifth
// game is found the way the first four were, without being added to a list.

import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const workspace = resolve(root, '..')
export const workingCopy = join(root, 'packages/room')

/** The published name, taken from the package rather than repeated here. */
export const pkgName = JSON.parse(readFileSync(join(workingCopy, 'package.json'), 'utf8')).name

/**
 * Names a manifest might still be using. The package was `@cc/room` until the
 * `@cc` scope turned out to belong to somebody else on npm, and a repo that
 * has not been moved across yet is still a consumer worth finding.
 */
export const knownNames = [pkgName, '@cc/room']

/** What `npm pack` calls the tarball for a version: @scope/name → scope-name. */
export const tarballName = (version) => `${pkgName.replace('@', '').replace('/', '-')}-${version}.tgz`

/** Every package.json in a repo that could plausibly name us. */
function manifestsIn(repo) {
  const found = [join(repo, 'package.json')]
  const pkgs = join(repo, 'packages')
  if (existsSync(pkgs)) {
    for (const d of readdirSync(pkgs)) found.push(join(pkgs, d, 'package.json'))
  }
  return found.filter((m) => existsSync(m))
}

/** The manifests in a repo that actually depend on one of our packages. */
function dependentManifests(repo) {
  return manifestsIn(repo).filter((m) => {
    try {
      const j = JSON.parse(readFileSync(m, 'utf8'))
      return Object.keys({ ...j.dependencies, ...j.devDependencies }).some((k) => knownNames.includes(k))
    } catch {
      return false // not ours to parse
    }
  })
}

/**
 * Wherever an installed copy of the library ended up in a repo — hoisted to
 * the root in the usual case, but a workspace can keep its own, so look for
 * both, under any name the repo might still be using.
 */
export function installedCopies(repo) {
  const roots = [join(repo, 'node_modules')]
  const pkgs = join(repo, 'packages')
  if (existsSync(pkgs)) {
    for (const d of readdirSync(pkgs)) roots.push(join(pkgs, d, 'node_modules'))
  }
  const candidates = roots.flatMap((r) => knownNames.map((n) => join(r, n)))
  return candidates.filter((c) => {
    try {
      lstatSync(c)
      return true
    } catch {
      return false
    }
  })
}

export function findConsumers() {
  return readdirSync(workspace, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => join(workspace, e.name))
    .filter((repo) => repo !== root)
    .map((repo) => ({ repo, name: repo.slice(workspace.length + 1), manifests: dependentManifests(repo) }))
    .filter((c) => c.manifests.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}
