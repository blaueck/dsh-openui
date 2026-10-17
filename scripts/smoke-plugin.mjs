/**
 * Boot the built plugin against a stub Cordis context.
 *
 * This exists because the decorator-lowering step is load-bearing and invisible:
 * if `@Remote(...)` survives into `lib/index.js`, the whole node half throws at
 * import and the plugin's tool silently disappears from every session. Importing
 * the built artifact and running `apply()` catches that before a restart does.
 *
 * It also proves the Remote service actually registers, which is the one thing
 * the running session could not tell us while it held an older module.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

// Isolate the profile registry: the plugin defaults to the real DSH profile, and
// a smoke test must not read or write the user's components.
const componentsDir = await mkdtemp(join(tmpdir(), 'dsh-openui-smoke-'))
const registryConfig = {
  customComponents: true,
  allowCodeComponents: true,
  componentsDir,
  maxComponents: 200,
}

const ctx = new Context()
const registered = []
const providers = []

ctx.provide('tools', { register: definition => { registered.push(definition.name); return () => {} } })
ctx.provide('skills', { registerProvider: factory => { providers.push(factory); return () => {} } })
ctx.provide('fs', {})
ctx.provide('agents', { get: () => undefined })

const plugin = await import('../lib/index.js')
plugin.apply(ctx, {
  maxSourceBytes: 256_000,
  allowedTools: ['glob'],
  writableTools: [],
  maxResultBytes: 256_000,
  callTimeoutMs: 20_000,
  ...registryConfig,
})

const remote = ctx.get('openuiRemote')
const catalog = remote === undefined ? undefined : await remote.catalog()
const components = remote === undefined ? undefined : await remote.components()

console.log('plugin name       :', plugin.name)
console.log('tools registered  :', registered.join(', ') || '(none)')
console.log('skill providers   :', providers.length)
console.log('openuiRemote      :', remote === undefined ? 'MISSING' : 'registered')
console.log('remote catalog    :', JSON.stringify(catalog))
console.log('registered list   :', JSON.stringify(components))

// Exercise the Remote through the Cordis service proxy, which is where the
// `#private`-field bug showed up: the proxy is the receiver, so only plain
// properties survive on `this`.
const executed = []
const ctx2 = new Context()
ctx2.provide('tools', {
  register: () => () => {},
  execute: async exec => {
    executed.push({ name: exec.name, args: exec.arguments, agent: exec.agent !== undefined })
    return { isError: false, value: { paths: ['src/a.ts'] }, content: [] }
  },
})
const agent = { id: 'agent-1' }
ctx2.provide('skills', { registerProvider: () => () => {} })
ctx2.provide('fs', {})
ctx2.provide('agents', { get: id => (id === 'sess-1' ? agent : undefined) })
plugin.apply(ctx2, {
  maxSourceBytes: 256_000, allowedTools: ['glob'], writableTools: [],
  maxResultBytes: 256_000, callTimeoutMs: 20_000, ...registryConfig,
})
const live = ctx2.get('openuiRemote')
const allowed = await live.call('sess-1', 'glob', { pattern: '*.ts' }, 'query')
const denied = await live.call('sess-1', 'bash', { command: 'rm -rf /' }, 'query')
const wrongKind = await live.call('sess-1', 'glob', {}, 'mutation')
const gone = await live.call('sess-2', 'glob', {}, 'query')

console.log('executed calls    :', JSON.stringify(executed))
console.log('allowed read      :', allowed.ok, JSON.stringify(allowed.value))
console.log('denied (bash)     :', denied.ok, '|', (denied.error ?? '').slice(0, 60))
console.log('wrong list        :', wrongKind.ok, '|', (wrongKind.error ?? '').slice(0, 60))
console.log('unknown session   :', gone.ok, '|', gone.error)

const ok = registered.includes('openui')
  && registered.includes('openui_component')
  && remote !== undefined
  && Array.isArray(components?.components)
  && components.components.length === 0
  && catalog?.query?.includes('glob')
  && executed.length === 1
  && allowed.ok === true
  && denied.ok === false
  && wrongKind.ok === false
  && gone.ok === false
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED')
process.exit(ok ? 0 : 1)
