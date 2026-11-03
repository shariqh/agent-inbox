'use strict'
// Issue #432 — where a launch's own git worktree goes, and its branch (design
// §1, §3). Main derives both from what it already checks (the folder, its
// project, the task and the launch id it makes before the confirmation), and
// shows them there; the renderer only asks for `worktree: true`. Main runs no
// git: it checks the folder holds a `.git` (a folder, or a linked worktree's
// file) with lstat, and the root and path the way the driver checks them again
// before `git worktree add` (src/worktree.ts). It creates nothing.
const fs = require('node:fs')
const path = require('node:path')

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// what Copilot's tool patterns would read (the driver's editsFolder refuses the same set)
// eslint-disable-next-line no-control-regex
const PATTERN_UNSAFE = /[()*?[\]{},\\\u0000-\u001f\u007f]/
const SLUG_MAX = 32

/** The task's first line as lowercase ASCII letters and digits joined by `-`, at most 32 characters cut at a `-`. */
function worktreeSlug(task) {
  const first = String(task).split(/\r\n|\r|\n/).find((line) => line.trim()) ?? ''
  let slug = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length > SLUG_MAX) {
    const cut = slug.slice(0, SLUG_MAX + 1).lastIndexOf('-')
    slug = (cut > 0 ? slug.slice(0, cut) : slug.slice(0, SLUG_MAX)).replace(/-+$/, '')
  }
  return slug || 'session'
}

/** The folder's project name when it is a plain name, else its basename, else `repo`. */
function worktreeRepoName(project, folder) {
  if (typeof project === 'string' && REPO_NAME.test(project)) return project
  const base = path.basename(String(folder))
  return REPO_NAME.test(base) ? base : 'repo'
}

/** `<root>/<repo>/<slug>-<short>` on `agent-inbox/<slug>-<short>`, `<short>` the launch id's first 8 digits. */
function planWorktree({ root, project, folder, task, launchId }) {
  const leaf = `${worktreeSlug(task)}-${String(launchId).slice(0, 8)}`
  return { path: path.join(root, worktreeRepoName(project, folder), leaf), branch: `agent-inbox/${leaf}` }
}

function ownedPrivate(info) {
  const uid = process.getuid?.() ?? -1
  return info.uid === uid && (info.mode & 0o022) === 0
}

// A real directory (no symlink anywhere on its path), owned by this user and
// not writable by group or others; or null when it does not exist.
function folderProblem(dir, what, fsImpl) {
  let info
  try {
    info = fsImpl.lstatSync(dir)
  } catch (error) {
    return error && error.code === 'ENOENT' ? null : `${what} ${dir} cannot be read.`
  }
  try {
    if (info.isSymbolicLink() || !info.isDirectory() || fsImpl.realpathSync(dir) !== dir) return `${what} ${dir} is a symlink or lies under one.`
  } catch {
    return `${what} ${dir} cannot be read.`
  }
  return ownedPrivate(info) ? null : `${what} ${dir} is not yours, or others can write to it.`
}

const exists = (dir, fsImpl) => {
  try {
    fsImpl.lstatSync(dir)
    return true
  } catch {
    return false
  }
}

/**
 * Why a worktree root chosen in Settings cannot be used, or null: an absolute,
 * existing real directory, owned by this user, not writable by others, with no
 * character Copilot's tool patterns would read.
 */
function worktreeRootProblem(root, { fsImpl = fs } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || root === '/') return 'Choose a folder.'
  if (PATTERN_UNSAFE.test(root)) return 'Choose a folder whose path has none of ( ) * ? [ ] { } , or \\.'
  if (!exists(root, fsImpl)) return `${root} does not exist.`
  return folderProblem(root, 'The folder', fsImpl)
}

/**
 * Why the planned worktree cannot be made, or null (§1, §3): `folder` (real)
 * must hold a `.git` folder or file; the root, when it exists, is a real folder
 * of this user's that others cannot write, outside the folder; when it does not,
 * it must be the default under the hub's folder, whose parent is real. The
 * repository folder under it, when it exists, is real too, and the path itself
 * does not exist yet.
 */
function worktreeProblem({ folder, root, defaultRoot, plan, fsImpl = fs }) {
  let git
  try {
    git = fsImpl.lstatSync(path.join(folder, '.git'))
  } catch { /* checked below */ }
  if (!git || !(git.isDirectory() || git.isFile())) {
    return `${folder} is not the top folder of a git repository. Untick New worktree to start in it.`
  }
  if (PATTERN_UNSAFE.test(plan.path)) {
    return `The worktree folder ${root} has one of ( ) * ? [ ] { } , or \\ in its path. Choose another in Settings → Agent sessions.`
  }
  // a root that holds the folder is fine, unless <root>/<repo> is the folder itself
  if ([root, plan.path].some((dir) => dir === folder || dir.startsWith(`${folder}/`))) {
    return `The worktree folder ${root} would put the worktree inside this repository. Choose another in Settings → Agent sessions.`
  }
  if (!exists(root, fsImpl)) {
    if (root !== defaultRoot) return `The worktree folder ${root} does not exist. Choose another in Settings → Agent sessions.`
    // the driver creates the default root, 0700, under the hub's own folder
    const parent = path.dirname(root)
    const why = exists(parent, fsImpl) ? folderProblem(parent, 'The folder', fsImpl) : `${parent} does not exist.`
    if (why) return why
  } else {
    const why = folderProblem(root, 'The worktree folder', fsImpl)
    if (why) return why
  }
  const why = folderProblem(path.dirname(plan.path), 'The worktree folder', fsImpl)
  if (why) return why
  if (exists(plan.path, fsImpl)) return `${plan.path} already exists.`
  return null
}

module.exports = { planWorktree, worktreeProblem, worktreeRepoName, worktreeRootProblem, worktreeSlug }
