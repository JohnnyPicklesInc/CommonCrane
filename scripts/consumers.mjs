// Run the games that consume this library against this working copy.
//
// They no longer follow it. Each names a released tarball, so an edit here
// reaches a game only when that game asks for it — which is the point, and
// also means their suites would now tell us nothing about what we are about to
// change. So this stands the working copy in place of the pinned copy for the
// length of the run, and puts the pinned one back afterwards: the question is
// "would releasing this break anybody", and that question needs the edit in.
//
// Discovered rather than listed: a fifth game is found by the same rule the
// first four were, which is having us in its dependencies.

import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, symlinkSync, lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { findConsumers, installedCopies, workingCopy } from './lib/consumers.mjs'

const consumers = findConsumers()

if (consumers.length === 0) {
  console.log('No consumers found beside this repo. Nothing to check.')
  process.exit(0)
}

/** Copies we have moved aside, so an interrupted run still puts them back. */
const swapped = []

function restoreAll() {
  while (swapped.length > 0) {
    const { path, stash } = swapped.pop()
    try {
      rmSync(path, { recursive: true, force: true })
      renameSync(stash, path)
    } catch (err) {
      console.error(`Could not restore ${path} from ${stash}: ${err.message}`)
    }
  }
}

process.on('exit', restoreAll)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll()
    process.exit(130)
  })
}

/** Whether an installed copy is already this working copy, symlinked. */
function isWorkingCopy(path) {
  try {
    return realpathSync(path) === realpathSync(workingCopy)
  } catch {
    return false
  }
}

/** Stand the working copy in for whatever version a repo has installed. */
function useWorkingCopy(repo) {
  for (const path of installedCopies(repo)) {
    if (isWorkingCopy(path)) continue
    const stash = `${path}.pinned`
    rmSync(stash, { recursive: true, force: true })
    renameSync(path, stash)
    symlinkSync(workingCopy, path, lstatSync(stash).isDirectory() ? 'dir' : 'file')
    swapped.push({ path, stash })
  }
}

/** Only the steps a repo actually has, so a missing one is skipped, not failed. */
function stepsIn(repo) {
  const j = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  return ['typecheck', 'test'].filter((s) => j.scripts?.[s] !== undefined)
}

const results = []
for (const { repo, name } of consumers) {
  useWorkingCopy(repo)
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
  restoreAll()
}

console.log('\n' + '='.repeat(52))
for (const r of results) {
  const secs = `${(r.ms / 1000).toFixed(1)}s`.padStart(7)
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${`${r.name} · ${r.step}`.padEnd(36)}${secs}`)
}
const failed = results.filter((r) => !r.ok)
console.log('='.repeat(52))
console.log(failed.length === 0 ? `${results.length} checks passed` : `${failed.length} of ${results.length} checks FAILED`)
console.log(`against the working copy, not the version each has pinned.`)
process.exit(failed.length === 0 ? 0 : 1)
