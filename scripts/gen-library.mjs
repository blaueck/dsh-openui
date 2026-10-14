/**
 * Regenerate the artifacts this plugin derives from the installed OpenUI
 * library, so the node half and the bundled skill never drift from the component
 * catalog the browser half actually renders.
 *
 * The target is the **chat** library, not the playground one. The frame loads
 * `@openuidev/browser-bundle`, whose global exposes `openuiChatLibrary` (root
 * `Card`) and nothing else; validating against `openuiLibrary` (root `Stack`)
 * would accept programs the browser cannot resolve — `Stack` and `Modal` exist
 * only there.
 *
 * Emits:
 * - `src/generated/library.schema.json` — the `LibraryJSONSchema` the `openui`
 *   tool validates model output against (`createParser(schema).parse(text)`).
 * - `src/generated/library-meta.json` — versions, root, component names.
 * - `src/generated/system-prompt.md` — the library's own generated system prompt.
 * - `skills/openui-skill.md` — the bundled skill body: a DSH-specific contract
 *   header wrapped around that prompt.
 *
 * Run with `pnpm gen`. Requires the devDependencies (`@openuidev/react-ui`,
 * react) because the library is a React component library; nothing here is
 * imported at plugin runtime.
 *
 * Telemetry: `@openuidev/lang-core` sends pseudonymous telemetry from a
 * `postinstall` script, and opt-in runtime telemetry when
 * `OPENUI_RUNTIME_TELEMETRY_ENABLED=1`. This script force-disables both, so
 * generating the prompt never reports anything.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPENUI_RUNTIME } from '../src/shell.ts'

process.env['OPENUI_TELEMETRY_DISABLED'] = '1'
process.env['DO_NOT_TRACK'] = '1'
delete process.env['OPENUI_RUNTIME_TELEMETRY_ENABLED']

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GENERATED = join(ROOT, 'src', 'generated')

/** Root statement name every program must define; the component is the library's own. */
const ROOT_STATEMENT = 'root'

/**
 * Version of a package whose manifest is not reachable as `<pkg>/package.json`.
 *
 * Found by walking up from the package's own entry point: `@openuidev/react-ui`
 * declares no `./package.json` export, so that specifier is captured by its
 * `./*` pattern and resolves to a path under `dist/components/`.
 * @param specifier - exact package name.
 * @returns the installed version.
 */
function packageVersion(specifier) {
  let dir = dirname(fileURLToPath(import.meta.resolve(specifier)))
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      if (manifest.name === specifier) return manifest.version
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`could not locate the manifest for ${specifier}`)
    dir = parent
  }
}

/**
 * Read the pinned version out of one jsDelivr URL.
 * @param url - a `.../npm/<pkg>@<version>/...` URL.
 * @returns the version, or `unknown`.
 */
function versionInUrl(url) {
  return /@(\d+\.\d+\.\d+[^/]*)\//u.exec(url)?.[1] ?? 'unknown'
}

async function main() {
  const { openuiChatLibrary, openuiChatPromptOptions } = await import('@openuidev/react-ui/genui-lib')

  if (typeof openuiChatLibrary?.toJSONSchema !== 'function') {
    throw new Error('openuiChatLibrary.toJSONSchema is unavailable — check @openuidev/react-ui')
  }
  if (typeof openuiChatLibrary?.prompt !== 'function') {
    throw new Error('openuiChatLibrary.prompt is unavailable — check @openuidev/react-lang')
  }

  const uiVersion = packageVersion('@openuidev/react-ui')
  const bundleVersion = versionInUrl(OPENUI_RUNTIME.bundle)
  const schema = openuiChatLibrary.toJSONSchema()
  const prompt = openuiChatLibrary.prompt(openuiChatPromptOptions)

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('openuiChatLibrary.prompt returned no text')
  }

  // `$defs` also carries data shapes (`ActionExpression`); the component catalog
  // is exactly the set of `properties` entries, each a `$ref` into `$defs`.
  const componentNames = Object.keys(schema?.properties ?? {}).sort()
  if (componentNames.length === 0) {
    throw new Error('the generated schema declares no components in `properties`')
  }
  const rootComponent = openuiChatLibrary.root
  if (typeof rootComponent !== 'string' || rootComponent.length === 0) {
    throw new Error('openuiChatLibrary.root is missing')
  }
  // The skill teaches `root = <rootComponent>(...)`; a schema that cannot accept
  // it would reject every program the model writes from the prompt.
  if (!componentNames.includes(rootComponent)) {
    throw new Error(`the library root "${rootComponent}" is not in the generated catalog`)
  }

  await mkdir(GENERATED, { recursive: true })
  await writeFile(join(GENERATED, 'library.schema.json'), `${JSON.stringify(schema, null, 2)}\n`, 'utf8')
  await writeFile(
    join(GENERATED, 'library-meta.json'),
    `${JSON.stringify({
      // The frame renders whatever `@openuidev/browser-bundle` carries, so the
      // bundle is the identity that matters; the npm version is what these
      // artifacts were generated from and must match it.
      libraryId: `@openuidev/browser-bundle@${bundleVersion} (openuiChatLibrary, generated from @openuidev/react-ui@${uiVersion})`,
      bundleVersion,
      uiVersion,
      root: ROOT_STATEMENT,
      rootComponent,
      componentCount: componentNames.length,
      componentNames,
    }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(join(GENERATED, 'system-prompt.md'), `${prompt.trimEnd()}\n`, 'utf8')

  const skillBody = renderSkill({ prompt, uiVersion, bundleVersion, rootComponent, componentNames })
  await mkdir(join(ROOT, 'skills'), { recursive: true })
  await writeFile(join(ROOT, 'skills', 'openui-skill.md'), skillBody, 'utf8')

  console.log(
    `dsh-openui: generated schema (${componentNames.length} components, root=${rootComponent}), `
    + `system prompt (${prompt.length} chars), skill body — openuiChatLibrary from `
    + `@openuidev/react-ui@${uiVersion}, rendered by browser-bundle@${bundleVersion}`,
  )
}

/**
 * Wrap the official OpenUI system prompt in the DSH-side contract: which Tool
 * answers it, the size ceiling, and how a card is corrected after the fact.
 * @param options - the generated prompt plus its provenance.
 * @returns the bundled skill body.
 */
function renderSkill({ prompt, uiVersion, bundleVersion, rootComponent, componentNames }) {
  return `---
name: openui
description: Authoring contract for the \`openui\` tool, which renders OpenUI Lang — the Open Standard for Generative UI — as a live interactive card in the conversation. Load before the first \`openui\` call in a session: it defines the statement grammar, the ${componentNames.length}-component catalog, positional-argument order, interactive bindings, and the actions a card can send back.
---

# Authoring OpenUI Lang for DSH

The \`openui\` tool takes one OpenUI Lang program and renders it as a live card in
the conversation. A capable client renders it inside a sandboxed frame; a client
without the browser half falls back to the tool's own result text, so the program
is still recorded. The card is interactive: \`$variables\` are reactive, forms
validate themselves, and a button's action can send a message back to you.

Catalog: \`openuiChatLibrary\` — ${componentNames.length} components, root
\`${rootComponent}\` — generated from \`@openuidev/react-ui@${uiVersion}\` and rendered by
\`@openuidev/browser-bundle@${bundleVersion}\`. The catalog below is the authority; do not invent
component names or props.

## Calling the tool

- \`source\` is the whole program. \`create\` (the default) renders a new card.
- To correct a card you already rendered, call \`update\` with its \`path\` and a
  \`patch\` of the statements you are changing. The patch is merged into the
  existing program **by statement name** — restate only \`root\` and the
  statements you mean to replace, and every other statement is kept. This is far
  cheaper than resending the program, so prefer it for a fix.
- The card appears while you generate. Emit \`root\` first, then state, then
  everything else, so the structure paints before the data arrives.
- A program is rejected if it has no \`root\`, references a component that is not
  in the catalog, calls a component with the wrong number of arguments, omits a
  required prop, or leaves a reference unresolved. Fix the reported statement and
  call again.
- Never put the program in a markdown fence and never write prose around it —
  the tool argument is the program itself.

## What the card can do

Everything below is client-side and needs no network:

- \`$name = defaultValue\` declares reactive state. Bindings read and write it.
- Forms validate on their own via the \`rules\` object.
- \`@ToAssistant("message")\` on a button sends that message back to you as a new
  user turn, carrying the form's current values. Use it for anything the user is
  meant to confirm, choose, or hand back.

## Live data: \`Query()\` and \`Mutation()\`

Both are wired in DSH, but **only for tools an operator has explicitly allowed**,
so most of the time they are not available and you should call your own tools and
inline the result as literals instead. That always works.

- \`Query("tool_name", args, defaults, refreshSeconds)\` fetches data while the
  card is on screen. Always pass a \`defaults\` value: it is what renders before
  the fetch resolves, and what stays on screen if the fetch is refused.
- \`Mutation("tool_name", args)\` runs when an action step fires it
  (\`Action([@Run(mutation), @Run(query)])\`), never on load.
- Two separate allowlists gate them: reads against one, writes against the other.
  A refusal arrives as a normal query error, so a card whose tool is not allowed
  still renders — with its \`defaults\`.
- A card re-runs its queries on its own: a changed \`$variable\`, a
  \`refreshSeconds\` tick. Keep queries cheap and narrow, and prefer one aggregate
  query over many small ones.
- A result over the host's size ceiling is refused rather than truncated, so ask
  for the columns and rows you will actually draw.

Do not guess at tool names. If you have not been told which tools a card may
call, inline the data instead.

---

# The OpenUI Lang specification

${prompt.trimEnd()}
`
}

await main()
