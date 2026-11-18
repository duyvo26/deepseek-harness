/**
 * Durable shadow-git checkpoints of a working directory.
 *
 * A checkpoint records what a directory held before one mutating tool call, so a
 * turn that produced the wrong change can be undone. The objects live in a
 * repository of this module's own under the harness home, addressed by the
 * directory's canonical path: nothing is written to the user's repository, their
 * index, their refs, or their object store, and their `git gc` cannot reach
 * these objects. That separation is the reason a workspace needs no repository at
 * all to be checkpointed.
 *
 * The shadow repository reaches the working directory through `--work-tree`, so a
 * plain directory and a checkout behave the same. Each checkpoint is a commit
 * under `refs/dsh/checkpoints/<session>/<turn>`; the ref is what keeps it alive,
 * because unreferenced objects are what a prune removes.
 *
 * @module checkpoint
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { GitRunner } from './git.ts'

/** Directory under the harness home that holds every shadow repository. */
export const CHECKPOINT_DIRECTORY = 'checkpoints'

/** Tree prefix that marks an encoded absolute path outside the work tree. */
const OUTSIDE_PREFIX = '.dsh-outside/'

/** Recorded paths one shadow repository holds for one working directory. */
export interface ShadowRepository {
  /** Absolute shadow repository root; its own `.git` lives inside. */
  readonly root: string
  /** Absolute git directory of the shadow repository. */
  readonly gitDir: string
  /** Canonical working directory this shadow repository checkpoints. */
  readonly workTree: string
}

/** One checkpoint: its commit and the paths the snapshot holds. */
export interface Checkpoint {
  /** Commit object id naming the snapshot. */
  readonly commit: string
  /** Working-directory-relative paths the snapshot recorded. */
  readonly paths: readonly string[]
}

/** One entry of a snapshot tree. */
interface TreeEntry {
  readonly oid: string
  readonly mode: string
  readonly path: string
}

/** Writes and reads the shadow repositories of one Host. */
export class CheckpointStore {
  /**
   * @param git - command runner shared with the owning plugin.
   * @param home - absolute harness home that holds {@link CHECKPOINT_DIRECTORY}.
   */
  constructor(
    private readonly git: GitRunner,
    private readonly home: string,
  ) {}

  /**
   * Open, creating on first use, the shadow repository of one working directory.
   *
   * The directory is named from the canonical path so two Sessions in the same
   * directory share one object store, which is what makes the blobs dedupe.
   * @param workTree - absolute canonical working directory to checkpoint.
   * @param signal - cancellation.
   * @returns the opened shadow repository.
   */
  async open(workTree: string, signal: AbortSignal): Promise<ShadowRepository> {
    const root = join(this.home, CHECKPOINT_DIRECTORY, hashPath(workTree))
    const gitDir = join(root, '.git')
    await mkdir(root, { recursive: true })
    const existing = await this.run(['--git-dir', gitDir, 'rev-parse', '--git-dir'], root, signal, true)
    if (existing.exitCode !== 0) await this.init(gitDir, workTree, root, signal)
    return { root, gitDir, workTree }
  }

  /**
   * Record the working directory's current content as a checkpoint.
   * @param shadow - repository to record in.
   * @param ref - full ref name to point at the new commit.
   * @param signal - cancellation.
   * @param extras - absolute paths outside the work tree the caller changed.
   * @returns the checkpoint, or undefined when the directory cannot be read.
   */
  async capture(
    shadow: ShadowRepository,
    ref: string,
    signal: AbortSignal,
    extras: readonly string[] = [],
  ): Promise<Checkpoint | undefined> {
    const scope = this.scope(shadow)
    const inside = extras.filter(path => path.startsWith(`${shadow.workTree}/`))
    const outside = extras.filter(path => !path.startsWith(`${shadow.workTree}/`))
    const added = await this.run(
      [...scope, 'add', '--all', '--ignore-errors', ...inside.length === 0 ? [] : ['--', ...inside]],
      shadow.workTree, signal, true,
    )
    // Exit code 1 reports unreadable files; the index is still complete, and a
    // checkpoint missing one file is more useful than none at all.
    if (added.exitCode !== 0 && added.exitCode !== 1) return undefined
    // `git add` refuses a path outside the work tree, so each outside file is
    // stored as a blob and entered under its absolute path directly.
    for (const path of outside) await this.stageOutside(shadow, path, signal)
    const tree = await this.run([...scope, 'write-tree'], shadow.workTree, signal)
    if (tree.exitCode !== 0) return undefined
    const commit = await this.run(
      [...scope, 'commit-tree', tree.stdout.trim(), '-m', `checkpoint ${ref}`],
      shadow.workTree, signal, false, COMMIT_IDENTITY,
    )
    if (commit.exitCode !== 0) return undefined
    const id = commit.stdout.trim()
    const pointed = await this.run([...scope, 'update-ref', ref, id], shadow.workTree, signal)
    if (pointed.exitCode !== 0) return undefined
    return { commit: id, paths: await this.paths(shadow, id, signal) }
  }

  /**
   * Read the checkpoint a ref names.
   * @param shadow - repository to read from.
   * @param ref - full ref name.
   * @param signal - cancellation.
   * @returns the checkpoint, or undefined when the ref is absent.
   */
  async read(shadow: ShadowRepository, ref: string, signal: AbortSignal): Promise<Checkpoint | undefined> {
    const found = await this.run([...this.scope(shadow), 'rev-parse', '--verify', '--quiet', ref], shadow.workTree, signal, true)
    const commit = found.stdout.trim()
    if (found.exitCode !== 0 || commit.length === 0) return undefined
    return { commit, paths: await this.paths(shadow, commit, signal) }
  }

  /**
   * Write one checkpoint's content back over the working directory.
   *
   * Files the snapshot lacks are deleted, so a turn that created a file leaves
   * none behind, and files it deleted are restored. Only the working directory is
   * written: the user's repository, index, and refs stay as they are.
   * @param shadow - repository to read from.
   * @param checkpoint - snapshot to apply.
   * @param signal - cancellation.
   * @returns the paths the restore wrote or removed, in snapshot order.
   * @throws when a blob cannot be read or a path cannot be written.
   */
  async restore(shadow: ShadowRepository, checkpoint: Checkpoint, signal: AbortSignal): Promise<readonly string[]> {
    const entries = await this.entries(shadow, checkpoint.commit, signal)
    const kept = new Set(entries.map(entry => entry.path))
    const before = new Set(await this.present(shadow, signal))
    const written: string[] = []
    for (const entry of entries) {
      const blob = await this.run([...this.scope(shadow), 'cat-file', 'blob', entry.oid], shadow.workTree, signal)
      if (blob.exitCode !== 0) throw new Error(`checkpoint blob ${entry.oid} is unreadable`)
      const target = this.absoluteOf(shadow, entry.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, blob.stdout, 'utf8')
      // Report the file the caller knows, not the index spelling of it.
      written.push(target)
    }
    for (const path of before) {
      if (kept.has(path)) continue
      const target = this.absoluteOf(shadow, path)
      await rm(target, { force: true })
      written.push(target)
    }
    return written
  }

  /**
   * Drop every checkpoint ref of one Session.
   * @param shadow - repository holding the refs.
   * @param sessionId - Session whose refs are dropped.
   * @param signal - cancellation.
   */
  async clearSession(shadow: ShadowRepository, sessionId: string, signal: AbortSignal): Promise<void> {
    const listed = await this.run(
      [...this.scope(shadow), 'for-each-ref', '--format=%(refname)', `refs/dsh/checkpoints/${sessionId}/`],
      shadow.workTree, signal,
    )
    const refs = listed.stdout.split('\n').filter(ref => ref.length > 0)
    if (refs.length === 0) return
    await this.run([...this.scope(shadow), 'update-ref', '--stdin'], shadow.workTree, signal, false, {},
      refs.map(ref => `delete ${ref}`).join('\n') + '\n')
  }

  /**
   * Create the shadow repository and its exclusion list.
   *
   * A shadow repository that shares a directory with a checkout would otherwise
   * record that checkout's own `.git`, doubling every checkpoint with the user's
   * history. The exclusion keeps the shadow repository to the files a user sees.
   * @param gitDir - git directory to create.
   * @param workTree - canonical working directory to record.
   * @param root - shadow repository root, which holds the exclusion file.
   * @param signal - cancellation.
   */
  private async init(gitDir: string, workTree: string, root: string, signal: AbortSignal): Promise<void> {
    await mkdir(gitDir, { recursive: true })
    const created = await this.run(['--git-dir', gitDir, 'init', '--quiet', '--bare'], root, signal)
    if (created.exitCode !== 0) throw new Error(`cannot create the checkpoint repository: ${created.stderr.trim()}`)
    // Objects must never be pruned while a ref still names them; refs are the
    // only thing standing between a checkpoint and a later `git gc --prune`.
    const settings: readonly (readonly [string, string])[] = [
      ['gc.auto', '0'], ['core.bare', 'false'], ['core.worktree', workTree],
      ['user.email', COMMIT_EMAIL], ['user.name', COMMIT_NAME],
    ]
    for (const [key, value] of settings) {
      await this.run(['--git-dir', gitDir, 'config', key, value], root, signal)
    }
    await writeFile(join(gitDir, 'info', 'exclude'), EXCLUDED.join('\n') + '\n')
  }

  /**
   * Arguments that address one shadow repository and its working directory.
   * @param shadow - repository to address.
   * @returns the leading `--git-dir` and `--work-tree` arguments.
   */
  private scope(shadow: ShadowRepository): string[] {
    return ['--git-dir', shadow.gitDir, '--work-tree', shadow.workTree]
  }

  /**
   * Recorded paths of one commit.
   * @param shadow - repository to read.
   * @param commit - commit object id.
   * @param signal - cancellation.
   * @returns paths relative to the working directory.
   */
  private async paths(shadow: ShadowRepository, commit: string, signal: AbortSignal): Promise<readonly string[]> {
    const listed = await this.run([...this.scope(shadow), 'ls-tree', '-r', '--name-only', '-z', commit], shadow.workTree, signal)
    return listed.stdout.split('\0').filter(path => path.length > 0)
  }

  /**
   * Entries of one commit's tree.
   * @param shadow - repository to read.
   * @param commit - commit object id.
   * @param signal - cancellation.
   * @returns one entry per recorded blob.
   */
  private async entries(shadow: ShadowRepository, commit: string, signal: AbortSignal): Promise<readonly TreeEntry[]> {
    const listed = await this.run([...this.scope(shadow), 'ls-tree', '-r', '-z', commit], shadow.workTree, signal)
    const entries: TreeEntry[] = []
    for (const record of listed.stdout.split('\0')) {
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const [mode, , oid] = record.slice(0, tab).split(' ')
      const path = record.slice(tab + 1)
      // A gitlink names a nested repository's commit, which this store cannot
      // materialize as content; restoring skips it rather than writing a stub.
      if (mode === undefined || oid === undefined || mode === '160000') continue
      entries.push({ oid, mode, path })
    }
    return entries
  }

  /**
   * Absolute filesystem path one recorded entry names.
   *
   * A path outside the work tree is recorded absolutely, because that is the
   * only way to address it; an inside path is relative and resolves against the
   * work tree.
   * @param shadow - repository the entry was recorded in.
   * @param path - recorded path.
   * @returns the file to read or write.
   */
  private absoluteOf(shadow: ShadowRepository, path: string): string {
    if (path.startsWith(OUTSIDE_PREFIX)) return decodeURIComponent(path.slice(OUTSIDE_PREFIX.length))
    return resolve(shadow.workTree, path)
  }

  /**
   * Store one file outside the work tree as a blob and enter it in the index.
   *
   * `git add` refuses a path outside the work tree, so the blob is written with
   * `hash-object` and the index entry added with `update-index`; the recorded
   * path is the absolute one, which restore reads back to the same file.
   * @param shadow - repository to record in.
   * @param path - absolute path of the file.
   * @param signal - cancellation.
   * @throws when the file cannot be read or the index rejects it.
   */
  private async stageOutside(shadow: ShadowRepository, path: string, signal: AbortSignal): Promise<void> {
    const scope = this.scope(shadow)
    const blob = await this.git.run(['--git-dir', shadow.gitDir, 'hash-object', '-w', '--', path], {
      cwd: shadow.root, signal,
    })
    if (blob.exitCode !== 0) throw new Error(`checkpoint cannot read ${path}: ${blob.stderr.trim()}`)
    // A git index holds only work-tree paths, so an outside file is recorded
    // under a reserved prefix with its absolute path encoded; restore reads the
    // same encoding back to the file it names.
    const recorded = `${OUTSIDE_PREFIX}${encodeURIComponent(path)}`
    const staged = await this.run(
      [...scope, 'update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${recorded}`],
      shadow.workTree, signal,
    )
    if (staged.exitCode !== 0) throw new Error(`checkpoint cannot record ${path}: ${staged.stderr.trim()}`)
  }

  /**
   * Paths the working directory holds now, as the shadow repository sees them.
   * @param shadow - repository to ask.
   * @param signal - cancellation.
   * @returns tracked paths relative to the working directory.
   */
  private async present(shadow: ShadowRepository, signal: AbortSignal): Promise<readonly string[]> {
    const scope = this.scope(shadow)
    const added = await this.run([...scope, 'add', '--all', '--ignore-errors'], shadow.workTree, signal, true)
    if (added.exitCode !== 0 && added.exitCode !== 1) return []
    const listed = await this.run([...scope, 'ls-files', '-z'], shadow.workTree, signal)
    return listed.stdout.split('\0').filter(path => path.length > 0)
  }

  /**
   * Run one git command against a shadow repository.
   * @param args - arguments after the executable.
   * @param cwd - directory to run in.
   * @param signal - cancellation.
   * @param allowFailure - whether a nonzero exit is an answer rather than an error.
   * @param env - extra environment entries.
   * @param stdin - data for the command's standard input.
   * @returns the settled command facts.
   */
  private async run(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal,
    allowFailure = false,
    env: Readonly<Record<string, string>> = {},
    stdin?: string,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const result = await this.git.run(args, { cwd, signal, env, ...stdin === undefined ? {} : { stdin } })
    if (result.exitCode !== 0 && !allowFailure) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}

/** Commit identity every checkpoint carries; the shadow repository publishes nothing. */
const COMMIT_NAME = 'dsh checkpoint'

/** Commit email every checkpoint carries. */
const COMMIT_EMAIL = 'checkpoint@dsh.local'

/** Environment that fixes the commit identity without reading the user's git config. */
const COMMIT_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: COMMIT_NAME,
  GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
  GIT_COMMITTER_NAME: COMMIT_NAME,
  GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
}

/** Work-tree paths no checkpoint records. */
const EXCLUDED: readonly string[] = [
  // A checkout's own repository holds the user's history, not their work.
  '.git/',
  // Harness state under the working directory is not the user's content.
  '.dsh/',
  'node_modules/',
]

/**
 * Stable directory name for one working directory.
 * @param workTree - canonical absolute path.
 * @returns a filesystem-safe name that is stable for the same path.
 */
function hashPath(workTree: string): string {
  return createHash('sha256').update(workTree).digest('hex').slice(0, 24)
}

/**
 * Read one text file, treating a missing file as absent content.
 * @param path - absolute file path.
 * @returns the file text, or undefined when it does not exist.
 */
export async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Full ref name one turn's checkpoint is stored under.
 * @param sessionId - owning Session; refs are kept per Session so disposal can drop them.
 * @param turn - the turn the snapshot precedes.
 * @returns the ref name.
 */
export function checkpointRef(sessionId: string, turn: number): string {
  return `refs/dsh/checkpoints/${sessionId}/${turn}`
}
