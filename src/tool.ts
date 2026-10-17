/**
 * The model-facing `openui` tool: take one OpenUI Lang program as a direct
 * argument, validate it against the generated component catalog, and project it
 * into the persisted `tool/result` meta so a capable UI renders it as a
 * sandboxed interactive card and replay reproduces the same card byte for byte.
 *
 * Passing the program as an argument (rather than a file path) lets the browser
 * half render it from the call's own arguments while it is still streaming —
 * OpenUI Lang is designed for exactly that, with forward references and a
 * top-down statement order. The settled program is also written to a card copy
 * under the OS temp directory, which is what a later `update` reads and merges
 * into, and the model-facing result stays a one-line confirmation.
 *
 * A program a query would drive is still accepted: without a `toolProvider` the
 * renderer shows each `Query()`'s own `defaults` argument and never fetches, so
 * the card is correct, just static.
 *
 * @module @blaueck/dsh-openui/tool
 */

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
// FsTarget is a value-free type; the import also pulls the `ctx.fs` Context merge.
import type { FsTarget } from '@deepseek-ai/dsh-fs'
// Type-only: pulls the `ctx.get('sandboxPolicy')` Context merge.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { OPENUI_LIBRARY_META, mergeOpenUi, validateOpenUi, type OpenUiProblem } from './library-spec.ts'
import type { ComponentStore } from './store.ts'
import type { CustomComponent } from './registry.ts'
import { SKILL_BODY_PATH, SKILL_RESOURCE_DIR } from './skill.ts'
import { OPENUI_TOOL_NAME, type OpenUiAction, type OpenUiMode } from './meta.ts'

export { OPENUI_TOOL_NAME } from './meta.ts'

/**
 * Local structural copy of the JSON value the meta channel accepts. The package
 * that owns the canonical type is a transitive dependency of `dsh-tools`, so
 * naming it here would add a dependency for one cast.
 */
type Json = null | string | number | boolean | Json[] | { [key: string]: Json }

const DESCRIPTION =
  'Answer with a live UI instead of prose: render an OpenUI Lang program — the '
  + 'Open Standard for Generative UI — as an interactive card in the conversation. '
  + 'The card is built from the official OpenUI component library '
  + `(${OPENUI_LIBRARY_META.componentCount} components: Card, CardHeader, TextContent, Table, `
  + 'BarChart/LineChart/PieChart/ScatterChart, Tabs, Accordion, Modal, Form with '
  + 'Input/Select/Slider/DatePicker, Buttons, Steps, Callout, and the card blocks). '
  + 'A program is a list of `name = Component(positionalArgs...)` statements, one per '
  + `line, starting with \`${OPENUI_LIBRARY_META.root} = ${OPENUI_LIBRARY_META.rootComponent}([...])\`; `
  + 'arguments are positional and follow catalog order. '
  + 'This profile may also have locally registered components, which this tool resolves '
  + 'before rendering; load the `openui-components` skill (when present) for their '
  + 'signatures and examples. '
  + 'Cards are interactive: `$variables` are reactive, forms validate themselves, '
  + 'and a button whose action is `@ToAssistant("...")` sends that message back to '
  + 'you as a new user turn with the form values. '
  + '`create` (the default) takes the whole program in `source`. To correct a card '
  + 'you already rendered, call `update` with its `path` and a `patch`: the patch is '
  + 'merged by statement name, so restate only what changes. '
  + 'A program with `Query()` still renders — with no tool provider attached it '
  + 'shows the query\'s own `defaults` argument and never fetches, so inline data '
  + 'you already have rather than expecting a fetch. '
  + 'The card appears while you generate, so write `root` first and data last. '
  + `Load the \`${OPENUI_TOOL_NAME}\` skill for the full grammar and component catalog before `
  + 'your first call. '
  // Agents without a skill tool (the minimal preset exposes only a shell) still
  // see this tool; naming the file gives them the same contract and ends a
  // fruitless search through the user's home for anything called "openui".
  + `If this session has no skill tool, read the same contract from ${SKILL_BODY_PATH} `
  + `(its relative paths resolve against ${SKILL_RESOURCE_DIR}) with a file or shell tool; `
  + 'do not search for it anywhere else.'

/**
 * Build the `openui` tool definition over the composed filesystem seam.
 * @param ctx - registrant context carrying `ctx.fs` for the card copy.
 * @param maxSourceBytes - deployment size ceiling for one program.
 * @param store - the profile's registered-component registry, when enabled.
 * @param allowCodeComponents - whether React code components are active. When
 *   false, code entries stay on disk but are invisible to this tool, to the
 *   skill, and to the browser half, so disabling the feature really disables it.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function openUiTool(
  ctx: Context,
  maxSourceBytes: number,
  store?: ComponentStore,
  allowCodeComponents = false,
): ToolDefinition {
  return defineTool({
    name: OPENUI_TOOL_NAME,
    description: DESCRIPTION,
    // Property order is user-visible: the model writes arguments in schema
    // order, and the streaming card reads its argument prefix in text order, so
    // the title and the width are written before the program, whose own value
    // stays open until the very end.
    parameters: {
      title: {
        type: 'string',
        description: 'Concise card title. Defaults to "OpenUI" on create; required on update.',
      },
      mode: {
        type: 'string',
        enum: ['inline', 'wide'],
        description: 'Card width: `inline` (default) or `wide` for side-by-side panel comparisons.',
      },
      action: {
        type: 'string',
        enum: ['create', 'update'],
        description:
          '`create` (default) renders a new card from `source`. `update` merges `patch` into the card '
          + 'at `path`; re-create the card when the change is structural rather than a few statements.',
      },
      path: {
        type: 'string',
        description: 'update only, required: path of the card to patch, as its own call reported it.',
      },
      patch: {
        type: 'string',
        description:
          'update only, required: OpenUI Lang statements to add or replace in the card at `path`. '
          + 'The merge is by statement name — restate `root` plus only the statements that change, and '
          + 'every other statement is kept. Statements the merge leaves unreachable are dropped.',
      },
      source: {
        type: 'string',
        description:
          'create only, required: the whole OpenUI Lang program. One `name = Component(args...)` '
          + 'statement per line, starting with `root = Stack([...])`. Arguments are positional, in the '
          + 'catalog order the skill gives. Emit `root` first, then `$state` declarations, then '
          + 'components, then leaf data, so the card paints progressively.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['create', 'update'] },
          path: { type: 'string', required: true },
          title: { type: 'string', required: true },
          mode: { type: 'string', required: true, enum: ['inline', 'wide'] },
          sizeBytes: { type: 'integer', required: true },
          statementCount: { type: 'integer', required: true },
          libraryId: { type: 'string', required: true },
          source: { type: 'string', required: true },
          // Registered components the program used, resolved before validation.
          components: { type: 'array', required: true, items: { type: 'string' } },
          // The same components' definitions, JSON-encoded. Not model-facing (the
          // render ignores it); it exists so `presentationMeta` can snapshot them
          // without a second registry read at replay time.
          customComponentsJson: { type: 'string', required: true },
          // The read/write split the browser half attributes card tool calls
          // with; see {@link OpenUiMeta.readTools}.
          readTools: { type: 'array', required: true, items: { type: 'string' } },
          writeTools: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      // Model-facing text stays a confirmation: the program is already in the
      // model's own output (the argument, whole or patched) and re-echoing it
      // would double its context cost. The patched path is named so a further
      // correction patches the new card rather than the superseded one.
      render: (_args, value) => {
        const size = `${humanBytes(value.sizeBytes)}, ${value.statementCount} statements`
        const via = value.components.length === 0
          ? ''
          : ` via registered component${value.components.length === 1 ? '' : 's'} ${value.components.join(', ')}`
        return [{
          type: 'text',
          text: value.action === 'update'
            ? `Patched "${value.title}" in place (${size}${via}; updated card at ${value.path}). The user sees the corrected UI in the conversation; patch that path for any further correction.`
            : `Rendered "${value.title}" as an OpenUI surface (${size}${via}; copy at ${value.path}). The user sees the interactive UI in the conversation.`,
        }]
      },
      // Project the program into persisted meta so the card survives replay: the
      // canonical value is not on the wire, only content + meta are.
      presentationMeta: (_args, value) => ({
        kind: 'openui',
        render: 'openui-lang',
        source: value.source,
        title: value.title,
        mode: value.mode,
        path: value.path,
        libraryId: value.libraryId,
        readTools: value.readTools,
        writeTools: value.writeTools,
        // Parsed back to an array by the browser half. Only the components this
        // card actually used are copied, so an unrelated registration does not
        // grow every card's meta.
        components: JSON.parse(value.customComponentsJson) as unknown as Json,
      }),
    },
    // A create writes only a content-addressed card copy; concurrent siblings
    // target distinct names or identical bytes, so they cannot conflict. An
    // update reads a card before rewriting it, so parallel updates would each
    // patch a base the other has already superseded.
    isConcurrencySafe: args => (args.action ?? 'create') === 'create',
    async execute(args, exec) {
      const action = (args.action ?? 'create') as OpenUiAction
      // Session-level sandbox policy, as the official fs tools resolve it: the
      // calling session's cwd becomes the workspace root. Without this, a
      // confining backend falls back to its process-level default root and
      // denies the write whenever the session cwd lies elsewhere.
      const sandboxPolicy = ctx.get('sandboxPolicy')?.resolve({
        ...exec.agent ? { session: exec.agent.session } : {},
      })
      const cwd = sandboxPolicy?.workspaceRoot ?? exec.agent?.session.header.cwd
      const resolveOpts = { ...cwd !== undefined ? { cwd } : {}, signal: exec.signal }
      // A patched card keeps its identity only if the caller restates it, so the
      // title is required on update rather than silently re-defaulted.
      const title = action === 'update'
        ? required(args.title, 'title', action).trim()
        : args.title?.trim() || 'OpenUI'
      const mode = (args.mode ?? 'inline') as OpenUiMode
      const components: readonly CustomComponent[] = store === undefined
        ? []
        : (await store.load()).components.filter(component => allowCodeComponents || component.kind === 'template')

      if (action === 'update') {
        const target = await ctx.fs.resolve(required(args.path, 'path', action), resolveOpts)
        let existing: string
        try {
          existing = await ctx.fs.readText(target, exec.signal)
        } catch {
          throw new Error(`invalid openui update: the card at ${target.displayPath} is not readable`)
        }
        const merged = mergeOpenUi(existing, required(args.patch, 'patch', action))
        const accepted = accept(merged, maxSourceBytes, components)
        const { source, sizeBytes, statementCount, readTools, writeTools, usedComponents } = accepted
        // Rewrite that same file rather than deriving a new name, so a second
        // patch in the same reply builds on the first — a fresh path per patch
        // would leave later patches addressing a base already superseded, and
        // each would silently drop every edit but its own.
        await ctx.fs.writeText(target, source, undefined, exec.signal, sandboxPolicy)
        return {
          action,
          path: target.displayPath,
          title,
          mode,
          sizeBytes,
          statementCount,
          libraryId: OPENUI_LIBRARY_META.libraryId,
          source,
          components: usedComponents,
          customComponentsJson: accepted.snapshot,
          readTools,
          writeTools,
        }
      }

      const accepted = accept(
        required(args.source, 'source', action),
        maxSourceBytes,
        components,
      )
      const { source, sizeBytes, statementCount, readTools, writeTools, usedComponents } = accepted
      // A create takes a content-addressed name so re-rendering identical bytes
      // reuses the same card copy.
      const written = await writeCard(
        path => ctx.fs.resolve(path, resolveOpts),
        (card, content) => ctx.fs.writeText(card, content, undefined, exec.signal, sandboxPolicy),
        `${slugOf(title)}-${contentHash(source)}.openui`,
        source,
        cwd,
      )
      return {
        action,
        path: written.displayPath,
        title,
        mode,
        sizeBytes,
        statementCount,
        libraryId: OPENUI_LIBRARY_META.libraryId,
        source,
        components: usedComponents,
        customComponentsJson: accepted.snapshot,
        readTools,
        writeTools,
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'OpenUI',
      kind: 'other',
    }),
    // The completed title derives from persisted meta, not args, so replay of a
    // defaulted title still shows the resolved one.
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = result.meta as { kind?: unknown; title?: unknown } | undefined
      if (meta?.kind !== 'openui' || typeof meta.title !== 'string') return undefined
      return { card: 'generic', title: `OpenUI · ${meta.title}` }
    },
  })
}

/**
 * Validate one program and reject it with the parser's own findings.
 * @param source - the program text.
 * @param maxSourceBytes - deployment size ceiling.
 * @returns the accepted program and its measurements.
 * @throws Error listing every fatal problem, phrased so the model can fix it.
 */
function accept(source: string, maxSourceBytes: number, components: readonly CustomComponent[]): {
  source: string
  sizeBytes: number
  statementCount: number
  readTools: string[]
  writeTools: string[]
  usedComponents: string[]
  /** JSON definitions of the used components, for the persisted meta snapshot. */
  snapshot: string
} {
  const trimmed = source.trim()
  if (trimmed.length === 0) {
    throw new Error('invalid openui program: the program is empty')
  }
  const sizeBytes = Buffer.byteLength(source, 'utf8')
  if (sizeBytes > maxSourceBytes) {
    throw new Error(
      `invalid openui program: ${humanBytes(sizeBytes)} exceeds the ${humanBytes(maxSourceBytes)} `
      + 'ceiling. Downsample the data it carries — inline fewer rows, or summarise rather than list.',
    )
  }
  const { problems, notes, statementCount, readTools, writeTools, usedComponents, expandedSource } = validateOpenUi(source, components)
  // The persisted program is the model's own text; only the render is expanded.
  // Still bound the expansion so one pathological call cannot hand the frame a
  // multi-megabyte program it has to re-parse on every keystroke.
  const expandedBytes = Buffer.byteLength(expandedSource, 'utf8')
  if (expandedBytes > maxSourceBytes * 4) {
    throw new Error(
      `invalid openui program: registered components expand it to ${humanBytes(expandedBytes)}, `
      + 'far past the source ceiling. Use fewer registered components, or inline the layout.',
    )
  }
  if (problems.length > 0) {
    throw new Error(
      `invalid openui program — ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`
      + problems.map(problem => `- ${problem.code}: ${problem.message}`).join('\n')
      + noteLine(notes)
      + `\nThe full grammar and component catalog are in the \`${OPENUI_TOOL_NAME}\` skill`
      + (components.length === 0 ? '.' : '; locally registered components are in the `openui-components` skill.'),
    )
  }
  const used = [...usedComponents]
  const usedDefs = components.filter(component => used.includes(component.name))
  return {
    source,
    sizeBytes,
    statementCount,
    readTools,
    writeTools,
    usedComponents: used,
    // Snapshot *definitions*, not names: replay must not depend on the registry
    // still holding the same code a month later.
    snapshot: JSON.stringify(usedDefs),
  }
}

/**
 * Render advisory notes as a trailing paragraph, or nothing.
 * @param notes - the advisory findings.
 * @returns the rendered line.
 */
function noteLine(notes: readonly OpenUiProblem[]): string {
  return notes.length === 0
    ? ''
    : `\nAdvisory (the program still renders): ${notes.map(note => note.message).join(' ')}`
}

/**
 * Take one argument the chosen action cannot run without. The parameter schema
 * cannot express "required on update only", so the per-action requirement is
 * enforced here and fails loud rather than defaulting into a wrong card.
 * @param value - the raw argument value.
 * @param name - the parameter name, as the model wrote it.
 * @param action - the action that requires it, named in the message.
 * @returns the raw value, whitespace preserved.
 * @throws Error naming the missing parameter; the tool surfaces it as `isError`.
 */
function required(value: string | undefined, name: string, action: OpenUiAction): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`invalid openui program: \`${name}\` is required when action is "${action}"`)
  }
  return value
}

/** Absolute OS-temp directory every card copy lands in. */
function cardDirectory(): string {
  const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : ''
  return join(tmpdir(), `dsh-openui${uid}`)
}

/**
 * Write one card copy to the first location that accepts it: the OS temp
 * directory, so card files never accumulate in the user's project and the
 * platform cleans them up, then a workspace `.dsh-openui/` directory as a
 * fallback for a backend that confines writes to the session workspace.
 * @param resolve - resolves one candidate path through the fs seam.
 * @param write - writes the payload to a resolved target.
 * @param name - content-addressed file name.
 * @param content - the program.
 * @param cwd - the session workspace root, when known.
 * @returns the target that accepted the write.
 * @throws Error when neither location accepts the write.
 */
async function writeCard(
  resolve: (path: string) => Promise<FsTarget>,
  write: (target: FsTarget, content: string) => Promise<unknown>,
  name: string,
  content: string,
  cwd: string | undefined,
): Promise<FsTarget> {
  const candidates = [join(cardDirectory(), name)]
  if (cwd !== undefined) candidates.push(join(cwd, '.dsh-openui', name))
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const target = await resolve(candidate)
      await write(target, content)
      return target
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    'invalid openui program: the card copy could not be written '
    + `(${lastError instanceof Error ? lastError.message : String(lastError)})`,
  )
}

/**
 * Reduce a title to a filesystem-safe slug.
 * @param title - the card title.
 * @returns a lowercase slug, or `card` when nothing survives.
 */
function slugOf(title: string): string {
  const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '')
  return slug.length === 0 ? 'card' : slug.slice(0, 60)
}

/**
 * Content-address a program so identical bytes reuse one card copy.
 * @param content - the program text.
 * @returns the first 16 hex characters of its SHA-256.
 */
function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Render a byte count for a confirmation line.
 * @param bytes - the size.
 * @returns a human-readable size.
 */
function humanBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} kB`
}
