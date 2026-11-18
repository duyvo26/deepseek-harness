/**
 * Summarizes the files each top-level turn changed from git working-tree
 * snapshots taken at turn start and turn end, plus whole-file captures taken
 * around each file-tool edit for paths git does not cover, and serves each
 * listed file's before-and-after comparison on demand. Each summary is
 * announced by a `workspace/changes` Session event that carries only the turn
 * number; summaries and comparisons are served through the `workspaceChanges`
 * service until the Session is disposed. Outside a git repository, or without
 * git, the summary lists file-tool edits only.
 */
import { homedir, tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { CheckpointStore, checkpointRef } from './checkpoint.ts'
import { GitRunner } from './git.ts'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { TurnRecorder } from './recorder.ts'
import type { WorkspaceChanges } from './types.ts'

export type {
  WorkspaceChangedFile, WorkspaceChanges, WorkspaceChangesSummary, WorkspaceDiffHunk, WorkspaceFileDiff,
} from './types.ts'

/** Stable Loader identity. */
export const name = 'workspace-changes'

/** Services used to run git, resolve mutation targets, and observe turns. */
export const inject = ['subprocess', 'fs']

/** Snapshot, capture, and comparison bounds. Invalid values fail plugin load. */
export interface Config {
  /** Milliseconds one git command may run before the turn's record is abandoned. */
  timeoutMs: number
  /** Bytes of git output retained per command; a larger diff listing abandons the record. */
  outputMaxBytes: number
  /** Maximum files carried by one summary; `total` still reports the complete count. */
  maxFiles: number
  /**
   * Bytes a file may hold to be captured around a file-tool edit or read from a snapshot for its comparison.
   * A larger file gets no comparison; one captured around a file-tool edit is also listed without counts.
   */
  maxFileBytes: number
  /** Milliseconds a line comparison may run before it degrades to whole-file replacement. */
  diffTimeoutMs: number
  /**
   * Directory holding the shadow repositories that make a turn restorable.
   *
   * Omitted uses `checkpoints` under the harness home, which keeps them out of
   * the user's own repository. Point it elsewhere to separate checkpoint storage
   * from the rest of the harness home.
   */
  checkpointHome?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(30_000),
  outputMaxBytes: z.number().default(8 * 1024 * 1024),
  maxFiles: z.number().default(500),
  maxFileBytes: z.number().default(2 * 1024 * 1024),
  diffTimeoutMs: z.number().default(100),
  checkpointHome: z.string(),
})

/**
 * Tools whose calls change the working directory and therefore need a checkpoint.
 *
 * A shell command can change any file, which is the reason it is included; the
 * cost is one checkpoint per turn rather than one per call, because the first
 * call of a turn is the one that records it.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write', 'edit', 'apply_patch', 'str_replace_editor', 'bash',
])

function eligible(session: Session): string | undefined {
  const { cwd, origin, delegationDepth } = session.header
  return origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd
}

/**
 * Resolve the git executable once. On macOS the Xcode stub at `/usr/bin/git`
 * opens an installer dialog instead of running, so it counts as absent until
 * developer tools are selected.
 * @param ctx - subprocess capability.
 * @param signal - plugin lifetime.
 * @returns the executable path, or null when git is unavailable.
 */
async function resolveGit(ctx: Context, signal: AbortSignal): Promise<string | null> {
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const probe = ctx.subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'], cwd: homedir(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1_000, signal,
  })
  const outcome = await probe.done.catch(() => ({ exitCode: null }))
  return outcome.exitCode === 0 ? executable : null
}

/**
 * Observe top-level turns of every Session with a working directory, capture
 * file-tool edits, announce change summaries, and serve them with their
 * comparisons as `workspaceChanges`.
 * @param ctx - host context with `subprocess` and `fs`.
 * @param config - validated bounds.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['timeoutMs', config.timeoutMs], ['outputMaxBytes', config.outputMaxBytes], ['maxFiles', config.maxFiles],
    ['maxFileBytes', config.maxFileBytes], ['diffTimeoutMs', config.diffTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`workspace-changes requires a positive integer ${field}`)
  }
  const lifetime = new AbortController()
  const recorders = new Map<Session, TurnRecorder>()
  const mutations = new WeakMap<object, TurnRecorder>()
  const byId = new Map<SessionId, TurnRecorder>()
  /** Working directory per Session, which restore addresses by id. */
  const cwds = new Map<SessionId, string>()
  /** `<session>:<turn>` pairs a checkpoint was recorded for, read at turn end. */
  const restorable = new Set<string>()
  const forget = (session: Session): Promise<void> => {
    const recorder = recorders.get(session)
    recorders.delete(session)
    byId.delete(session.id)
    cwds.delete(session.id)
    return recorder?.dispose() ?? Promise.resolve()
  }
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.all([...recorders.keys()].map(forget))
  })
  let runner: Promise<GitRunner | null> | undefined
  const gitRunner = (): Promise<GitRunner | null> => {
    runner ??= resolveGit(ctx, lifetime.signal).then((executable) => {
      if (executable === null) {
        ctx.logger.info('workspace-changes: git is unavailable; only file-tool edits are summarized')
        return null
      }
      return new GitRunner(ctx.subprocess, executable, { timeoutMs: config.timeoutMs, outputMaxBytes: config.outputMaxBytes })
    })
    return runner
  }
  // Checkpoints live in a repository of this plugin's own under the harness
  // home: writing them into the user's repository would make them visible to
  // their `git fsck`, compete with their staging, and vanish on their next
  // `git gc`.
  let shadow: Promise<CheckpointStore | null> | undefined
  const checkpointStore = (): Promise<CheckpointStore | null> => {
    shadow ??= gitRunner().then((git) => {
      if (git === null) return null
      return new CheckpointStore(git, config.checkpointHome ?? dshHomePath())
    })
    return shadow
  }
  const service: WorkspaceChanges = {
    summary: (sessionId, seq) => byId.get(sessionId)?.summary(seq),
    diff: (sessionId, seq, index, signal) => byId.get(sessionId)?.diff(seq, index, signal) ?? Promise.resolve(undefined),
    restoreTurn: async (sessionId, turn, signal) => await restoreTurn(sessionId, turn, signal),
  }
  /**
   * Write one turn's start state back over its working directory.
   * @param sessionId - Session whose turn is undone.
   * @param turn - turn to return to its start.
   * @param signal - cancellation.
   * @returns the written and removed paths, or undefined without a checkpoint.
   */
  async function restoreTurn(sessionId: SessionId, turn: number, signal: AbortSignal): Promise<readonly string[] | undefined> {
    const cwd = cwds.get(sessionId)
    const store = await checkpointStore()
    if (cwd === undefined || store === null) return undefined
    const shadow = await store.open(cwd, signal)
    const checkpoint = await store.read(shadow, checkpointRef(sessionId, turn), signal)
    if (checkpoint === undefined) return undefined
    return await store.restore(shadow, checkpoint, signal)
  }
  ctx.provide('workspaceChanges', service)
  const recorderFor = (session: Session, cwd: string): TurnRecorder => {
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new TurnRecorder(session, cwd, {
        git: gitRunner(), tempRoot: tmpdir(), maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes, diffTimeoutMs: config.diffTimeoutMs,
        warn: (message) => { ctx.logger.warn(message) },
      })
      recorders.set(session, recorder)
      byId.set(session.id, recorder)
      cwds.set(session.id, cwd)
    }
    return recorder
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const cwd = eligible(session)
      if (cwd !== undefined) recorderFor(session, cwd).start(event.data.turn)
      return
    }
    if (event.type === 'tool/result') recorders.get(session)?.observe(event)
    else if (event.type === 'turn/end') {
      // A turn the Host checkpointed is restorable, and only the record built
      // here knows that, so the fact is handed over rather than set later.
      const key = `${session.id}:${event.data.turn}`
      recorders.get(session)?.end(event.data.turn, restorable.has(key))
      restorable.delete(key)
    }
  })
  ctx.on('session/disposed', (session) => { void forget(session) })
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    await recorders.get(agent.session)?.stopping(turn)
  })
  const capture = async (target: FsTarget, actor: object | undefined): Promise<void> => {
    const recorder = actor === undefined ? undefined : mutations.get(actor)
    if (recorder === undefined) return
    recorder.capture(ctx.fs.processPath(target))
    await recorder.settled()
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('fs/delete-intent', async (target, actor, next) => {
    const intent = await next()
    await capture(target, actor)
    return intent
  }, { prepend: true })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    const recorder = session === undefined ? undefined : recorders.get(session)
    if (recorder !== undefined) {
      mutations.set(exec, recorder)
      await recorder.settled()
    }
    if (session !== undefined && MUTATING_TOOLS.has(exec.name)) {
      await checkpointBefore(session, exec.name, touchedPaths(exec.arguments))
    }
    return next()
  })
  /**
   * Absolute paths one tool call names as its write targets.
   *
   * A tool writes where its arguments say, which need not be inside the
   * Session's directory: `write` accepts an absolute path. Those targets are
   * what a checkpoint has to cover for an undo to put them back.
   * @param args - the call's parsed arguments, when it has an object form.
   * @returns absolute paths the call may change, in argument order.
   */
  function touchedPaths(args: unknown): readonly string[] {
    if (typeof args !== 'object' || args === null) return []
    const record = args as Record<string, unknown>
    const found: string[] = []
    for (const key of ['file_path', 'path']) {
      const value = record[key]
      if (typeof value === 'string' && isAbsolute(value)) found.push(value)
    }
    return found
  }

  /**
   * Record the working directory before a mutating call so its turn can be undone.
   *
   * A checkpoint that fails never blocks the call: the user asked for the edit,
   * and losing the ability to undo it is not a reason to refuse it. The failure
   * is logged, and restore reports no checkpoint for that turn.
   * @param session - Session the call belongs to.
   * @param toolName - the mutating tool, recorded in the log message only.
   */
  async function checkpointBefore(
    session: Session,
    toolName: string,
    targets: readonly string[],
  ): Promise<void> {
    const cwd = cwds.get(session.id)
    const turn = recorders.get(session)?.openTurn
    if (cwd === undefined || turn === undefined) return
    const store = await checkpointStore()
    if (store === null) return
    try {
      const shadow = await store.open(cwd, lifetime.signal)
      const ref = checkpointRef(session.id, turn)
      // One checkpoint per turn is what restore addresses, and re-recording it on
      // every call in the turn would only move it forward past earlier edits.
      if (await store.read(shadow, ref, lifetime.signal) !== undefined) return
      const captured = await store.capture(shadow, ref, lifetime.signal, targets)
      if (captured === undefined) {
        ctx.logger.warn(`checkpoint: could not record ${cwd} before ${toolName}`)
        return
      }
      restorable.add(`${session.id}:${turn}`)
      session.append('workspace/checkpoint', { turn })
    } catch (error: unknown) {
      ctx.logger.warn(`checkpoint: recording before ${toolName} failed: ${String(error)}`)
    }
  }
}
