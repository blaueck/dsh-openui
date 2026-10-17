/**
 * The `openui_component` tool's own loop: register, update, list, remove, and
 * the code gate — through the definition the tools registry would receive.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { openUiComponentTool } from '../src/register-tool.ts'
import { ComponentStore } from '../src/store.ts'

/** A no-op execution context; this tool never touches it. */
const EXEC = { signal: new AbortController().signal } as ToolRunContext

/** Directories created by one test, removed afterwards. */
const created: string[] = []

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One temp store and the tool over it. */
async function harness(allowCode: boolean): Promise<{ store: ComponentStore; tool: ReturnType<typeof openUiComponentTool>; changes: () => number }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-openui-tool-'))
  created.push(directory)
  const store = new ComponentStore({ directory })
  let changes = 0
  const tool = openUiComponentTool(store, { allowCode }, () => { changes += 1 })
  return { store, tool, changes: () => changes }
}

const PROPS = [
  { name: 'label', type: 'string' as const, required: true },
  { name: 'count', type: 'number' as const, required: true },
]
const CODE = '(props) => React.createElement("div", null, props.label, " ", props.count)'
const EXAMPLE = 'root = Card([s])\ns = StatCard("Runs", 3)\n'

describe('openui_component', () => {
  it('registers a React component, then lists, updates and removes it', async () => {
    const { store, tool, changes } = await harness(true)
    const registered = await tool.execute({
      name: 'StatCard',
      description: 'A number with a label.',
      props: PROPS,
      code: CODE,
      example: EXAMPLE,
    }, EXEC) as { count: number; path: string; name: string }
    expect(registered.count).toBe(1)
    expect(registered.path.endsWith('stat-card.json')).toBe(true)
    expect((await store.load()).components[0]?.kind).toBe('react')
    expect(changes()).toBe(1)

    const listed = await tool.execute({ action: 'list' }, EXEC) as { components: string[]; count: number }
    expect(listed.count).toBe(1)
    expect(listed.components[0]).toContain('StatCard(label: string, count: number)')

    const updated = await tool.execute({
      action: 'update',
      name: 'StatCard',
      description: 'A number.',
      props: PROPS,
      code: CODE,
      example: EXAMPLE,
    }, EXEC) as { count: number }
    expect(updated.count).toBe(1)
    expect(changes()).toBe(2)

    const removed = await tool.execute({ action: 'remove', name: 'StatCard' }, EXEC) as { count: number }
    expect(removed.count).toBe(0)
    expect(changes()).toBe(3)
    expect((await store.load()).components).toEqual([])
  })

  it('refuses a React component when the profile has not enabled code', async () => {
    const { tool } = await harness(false)
    await expect(tool.execute({
      name: 'StatCard',
      description: 'x',
      props: PROPS,
      code: CODE,
    }, EXEC)).rejects.toThrow(/allowCodeComponents/u)
  })

  it('registers a template component even with code disabled', async () => {
    const { store, tool } = await harness(false)
    const registered = await tool.execute({
      name: 'FlightCard',
      description: 'One flight.',
      props: [{ name: 'from', type: 'string', required: true }],
      template: 'Card([CardHeader({{from}})])',
      example: 'root = Card([f])\nf = FlightCard("SFO")\n',
    }, EXEC) as { count: number }
    expect(registered.count).toBe(1)
    expect((await store.load()).components[0]?.kind).toBe('template')
  })

  it('refuses an unknown name for update and remove', async () => {
    const { tool } = await harness(false)
    await expect(tool.execute({
      action: 'update',
      name: 'Nope',
      description: 'x',
      props: [],
      template: 'Card([])',
    }, EXEC)).rejects.toThrow(/not registered/u)
    await expect(tool.execute({ action: 'remove', name: 'Nope' }, EXEC)).rejects.toThrow(/not registered/u)
  })
})
