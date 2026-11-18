/** Session deletion: the stored artifact goes, the Workspace record goes with it, and an open Session needs permission. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

/** A Host context with the registries a delete reaches. */
async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await installSessionReadTestServices(ctx)
  return ctx
}

/** A persistence double recording the delete and reporting the artifact it holds. */
function persistenceDouble(held: readonly string[] = ['session-delete']) {
  const deleted: string[] = []
  return {
    deleted,
    service: {
      stat: async (id: SessionId) => held.includes(id) ? { header: { id }, revision: 'test' } : undefined,
      delete: async (id: SessionId) => { deleted.push(id) },
      list: async () => [],
    } as never,
  }
}

/** The command controller over a context whose persistence holds one Session. */
function controller(ctx: Context, persistence: ReturnType<typeof persistenceDouble>['service'], detach = vi.fn(async () => {})) {
  ctx.provide('sessionPersistence', persistence)
  ctx.provide('workspaceRegistry', { detachSession: detach, list: () => [], get: () => undefined, archivedSessionIds: [] } as never)
  return {
    detach,
    command: new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/default'),
  }
}

describe('deleteSession', () => {
  it('removes the stored artifact and detaches the Workspace record', async () => {
    const ctx = await baseContext()
    const persistence = persistenceDouble()
    const { command, detach } = controller(ctx, persistence.service)

    const result = await command.deleteSession({ sessionId: brandString<SessionId>('session-delete') })

    expect(result).toEqual({ deleted: true })
    expect(persistence.deleted).toEqual(['session-delete'])
    // The Workspace record goes first, so it never names a Session readers cannot open.
    expect(detach).toHaveBeenCalledWith('session-delete')
    await ctx.fiber.dispose()
  })

  it('removes the artifact before detaching, so no list read sees it ungrouped', async () => {
    const ctx = await baseContext()
    const order: string[] = []
    const persistence = {
      stat: async () => ({ header: { id: 'session-order' }, revision: 'test' }),
      delete: async () => { order.push('artifact') },
      list: async () => [],
    } as never
    ctx.provide('sessionPersistence', persistence)
    ctx.provide('workspaceRegistry', {
      detachSession: async () => { order.push('detach') },
      list: () => [], get: () => undefined, archivedSessionIds: [],
    } as never)
    const command = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/default')

    await command.deleteSession({ sessionId: brandString<SessionId>('session-order') })

    // A Session that left its Workspace while its log still existed would show
    // in the ungrouped bucket for the next read.
    expect(order).toEqual(['artifact', 'detach'])
    await ctx.fiber.dispose()
  })

  it('reports nothing removed for a Session this store does not hold', async () => {
    const ctx = await baseContext()
    const persistence = persistenceDouble([])
    const { command } = controller(ctx, persistence.service)

    expect(await command.deleteSession({ sessionId: brandString<SessionId>('never-stored') }))
      .toEqual({ deleted: false })
    expect(persistence.deleted).toEqual([])
    await ctx.fiber.dispose()
  })

  it('refuses an open Session unless stopping its work is allowed', async () => {
    const ctx = await baseContext()
    const persistence = persistenceDouble(['session-open'])
    const { command } = controller(ctx, persistence.service)
    ctx.sessions.create(brandString<SessionId>('session-open'), { meta: { cwd: '/work' } })

    await expect(command.deleteSession({ sessionId: brandString<SessionId>('session-open') }))
      .rejects.toMatchObject({ code: 'session/active' })
    expect(persistence.deleted).toEqual([])

    // Permission to stop its work is what lets the destructive call through.
    expect(await command.deleteSession({
      sessionId: brandString<SessionId>('session-open'), stopActivity: true,
    })).toEqual({ deleted: true })
    await ctx.fiber.dispose()
  })

  it('refuses when this Host composed no session storage', async () => {
    const ctx = await baseContext()
    const command = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/default')

    await expect(command.deleteSession({ sessionId: brandString<SessionId>('session-any') }))
      .rejects.toMatchObject({ code: 'session/persistence-unavailable' })
    await ctx.fiber.dispose()
  })
})
