// Run the games that consume this library against this working copy.
//
// They depend on it as a `file:` link, so an edit here is already in every one
// of them the moment it is saved. There is no version to pin and no boundary
// to hold a breaking change back — and the only suite that would notice is
// theirs, in a repo nobody has open. So run theirs, from here.
//
// Discovered rather than listed: a fourth game is found by the same rule the
// first three were, which is having us in its dependencies.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(root, '..')

/** Whether a package.json anywhere in this repo depends on us. */
function dependsOnUs(repo) {
  const manifests = [join(repo, 'package.json')]
  const pkgs = join(repo, 'packages')
  if (existsSync(pkgs)) {
    for (const d of readdirSync(pkgs)) manifests.push(join(pkgs, d, 'package.json'))
  }
  return manifests.some((m) => {
    if (!existsSync(m)) return false
    try {
      const j = JSON.parse(readFileSync(m, 'utf8'))
      return Object.keys({ ...j.dependencies, ...j.devDependencies }).some((k) =>
        k.startsWith('@cc/'),
      )
    } catch {
      return false // not ours to parse
    }
  })
}

const consumers = readdirSync(workspace, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
  .map((e) => join(workspace, e.name))
  .filter((repo) => repo !== root && dependsOnUs(repo))
  .sort()

if (consumers.length === 0) {
  console.log('No consumers found beside this repo. Nothing to check.')
  process.exit(0)
}

/** Only the steps a repo actually has, so a missing one is skipped, not failed. */
function stepsIn(repo) {
  const j = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  return ['typecheck', 'test'].filter((s) => j.scripts?.[s] !== undefined)
}

const results = []
for (const repo of consumers) {
  const name = repo.slice(workspace.length + 1)
  for (const step of stepsIn(repo)) {
    process.stdout.write(`\n── ${name} · ${step} ${'─'.repeat(Math.max(0, 46 - name.length - step.length))}\n`)
    const started = Date.now()
    try {
      execFileSync('npm', ['run', '--silent', step], { cwd: repo, stdio: 'inherit' })
      results.push({ name, step, ok: true, ms: Date.now() - started })
    } catch {
      results.push({ name, step, ok: false, ms: Date.now() - started })
    }
  }
}

console.log('\n' + '='.repeat(52))
for (const r of results) {
  const secs = `${(r.ms / 1000).toFixed(1)}s`.padStart(7)
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${`${r.name} · ${r.step}`.padEnd(36)}${secs}`)
}
const failed = results.filter((r) => !r.ok)
console.log('='.repeat(52))
console.log(failed.length === 0 ? `${results.length} checks passed` : `${failed.length} of ${results.length} checks FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
