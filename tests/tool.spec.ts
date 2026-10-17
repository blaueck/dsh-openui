/**
 * The `openui` tool over a real registry: validation, the raw program that is
 * persisted, and the component snapshot projected into card meta.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ReactComponent, TemplateComponent } from '../src/registry.ts'
import { ComponentStore } from '../src/store.ts'
import { openUiTool } from '../src/tool.ts'

const FLIGHT: TemplateComponent = {
  kind: 'template',
  name: 'FlightCard',
  description: 'One flight option.',
  props: [
    { name: 'from', type: 'string', required: true },
    { name: 'to', type: 'string', required: true },
    { name: 'depart', type: 'string', required: true },
    { name: 'price', type: 'number', required: true },
  ],
  template: 'Card([CardHeader({{from}} + " → " + {{to}}, {{depart}}), TextContent("$" + {{price}})])',
}

const STAT: ReactComponent = {
  kind: 'react',
  name: 'StatCard',
  description: 'A number with a label.',
  props: [
    { name: 'label', type: 'string', required: true },
    { name: 'count', type: 'number', required: true },
  ],
  code: '(props) => React.createElement("div", null, props.label, " ", props.count)',
}

const TEMPLATE_PROGRAM = 'root = Card([f])\nf = FlightCard("SFO", "NRT", "10:30", 640)\n'
const REACT_PROGRAM = 'root = Card([s])\ns = StatCard("Runs", 3)\n'

/** Directories created by one test, removed afterwards. */
const created: string[] = []

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A filesystem seam that keeps card copies in a map. */
function harness(): {
  ctx: Context
  exec: ToolRunContext
  files: Map<string, string>
} {
  const files = new Map<string, string>()
  const ctx = {
    get: () => undefined,
    fs: {
      resolve: async (path: string) => ({ displayPath: path, path }),
      writeText: async (target: { path: string }, content: string) => {
        files.set(target.path, content)
      },
      readText: async (target: { path: string }) => {
        const content = files.get(target.path)
        if (content === undefined) throw new Error('missing')
        return content
      },
    },
  } as unknown as Context
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: '/tmp/workspace' } } },
  } as unknown as ToolRunContext
  return { ctx, exec, files }
}

/** Create the temp store the tool will read. */
async function storeWith(components: readonly (TemplateComponent | ReactComponent)[]): Promise<ComponentStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-openui-tool-'))
  created.push(directory)
  const store = new ComponentStore({ directory })
  for (const component of components) await store.save(component)
  return store
}

describe('openui tool with a registry', () => {
  it('accepts a template component, persists the raw program, and snapshots the definition', async () => {
    const store = await storeWith([FLIGHT])
    const { ctx, exec, files } = harness()
    const tool = openUiTool(ctx, 256_000, store, false)
    const value = await tool.execute({ title: 'Flight', source: TEMPLATE_PROGRAM }, exec) as {
      components: string[]
      customComponentsJson: string
      path: string
      source: string
    }
    expect(value.components).toEqual(['FlightCard'])
    expect(value.source.trimEnd()).toBe(TEMPLATE_PROGRAM.trimEnd())
    // The card copy keeps what the model wrote, so a later patch addresses the
    // same statement names; expansion happens at validation and render time.
    expect(files.get(value.path)).toContain('FlightCard(')
    expect(value.customComponentsJson).toContain('FlightCard')

    const meta = tool.output.presentationMeta?.({}, value as never) as { components?: unknown[] }
    expect(meta.components?.[0]).toMatchObject({ name: 'FlightCard', kind: 'template' })
  })

  it('accepts a React component, validates its props, and snapshots its code', async () => {
    const store = await storeWith([STAT])
    const { ctx, exec } = harness()
    const tool = openUiTool(ctx, 256_000, store, true)
    const value = await tool.execute({ title: 'Stats', source: REACT_PROGRAM }, exec) as {
      components: string[]
      customComponentsJson: string
    }
    expect(value.components).toEqual(['StatCard'])
    expect(value.customComponentsJson).toContain('React.createElement')
    const meta = tool.output.presentationMeta?.({}, value as never) as { components?: unknown[] }
    expect(meta.components?.[0]).toMatchObject({ name: 'StatCard', kind: 'react' })
  })

  it('hides a React component when code components are disabled', async () => {
    const store = await storeWith([STAT])
    const { ctx, exec } = harness()
    const tool = openUiTool(ctx, 256_000, store, false)
    await expect(tool.execute({ title: 'Stats', source: REACT_PROGRAM }, exec))
      .rejects.toThrow(/unknown-component/u)
  })

  it('patches a raw program by statement name and re-expands it', async () => {
    const store = await storeWith([FLIGHT])
    const { ctx, exec } = harness()
    const tool = openUiTool(ctx, 256_000, store, false)
    const created = await tool.execute({ title: 'Flight', source: TEMPLATE_PROGRAM }, exec) as { path: string }
    const patched = await tool.execute({
      action: 'update',
      title: 'Flight',
      path: created.path,
      patch: 'f = FlightCard("SFO", "HND", "11:00", 700)\n',
    }, exec) as { source: string; action: string }
    expect(patched.action).toBe('update')
    expect(patched.source).toContain('"HND"')
    expect(patched.source).toContain('FlightCard(')
  })
})
