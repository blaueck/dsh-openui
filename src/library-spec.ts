/**
 * The validated OpenUI surface: the generated library schema plus the parse,
 * validate and merge operations the `openui` tool performs on model output.
 *
 * The schema is generated from the installed `@openuidev/react-ui/genui-lib`
 * by `scripts/gen-library.mjs` and checked in, so this module has no React
 * dependency and no filesystem read at runtime — the node half loads it as
 * data and the parser (`@openuidev/lang-core`) does the work.
 *
 * @module @blaueck/dsh-openui/library-spec
 */

import {
  createParser,
  mergeStatements,
  type LibraryJSONSchema,
  type ParseResult,
  type ValidationError,
} from '@openuidev/lang-core'
import schema from './generated/library.schema.json' with { type: 'json' }
import meta from './generated/library-meta.json' with { type: 'json' }

/** Provenance and shape of the catalog this build validates against. */
export interface OpenUiLibraryMeta {
  /** Exact identity of the catalog, for the card and the log. */
  libraryId: string
  /** `@openuidev/browser-bundle` version the frame actually renders. */
  bundleVersion: string
  /** `@openuidev/react-ui` version these artifacts were generated from. */
  uiVersion: string
  /** Root statement name every program must define. */
  root: string
  /** Component the root statement must call, e.g. `Card`. */
  rootComponent: string
  /** Number of components the catalog defines. */
  componentCount: number
  /** Every component name, for error messages that suggest near misses. */
  componentNames: string[]
}

/** The catalog metadata emitted beside the schema. */
export const OPENUI_LIBRARY_META: OpenUiLibraryMeta = meta

/**
 * The parser's schema. `LibraryJSONSchema.properties` maps component names to
 * a `$ref`, and `$defs` holds each component's own JSON Schema; built-in
 * functions (`@Count`, `@Filter`, …) live in the parser's own table and are
 * absent here by design.
 */
export const OPENUI_LIBRARY_SCHEMA: LibraryJSONSchema = schema as unknown as LibraryJSONSchema

/** Hard reasons a program cannot be rendered at all. */
const FATAL_CODES: ReadonlySet<string> = new Set([
  'unknown-component',
  'missing-required',
  'null-required',
  'excess-args',
  'inline-reserved',
  'no-root',
])

/** One reason a program was rejected or flagged, already phrased for a model. */
export interface OpenUiProblem {
  /** Machine-readable origin: a parser error code, or a check this module adds. */
  code: string
  /** Actionable sentence naming the statement and what to change. */
  message: string
}

/**
 * Outcome of validating one program. `problems` are fatal — the tool refuses
 * the program and returns them so the model can correct the named statement.
 * `notes` are advisory and never block.
 */
export interface OpenUiValidation {
  /** Fatal reasons; empty means the program renders. */
  problems: OpenUiProblem[]
  /** Advisory notes (unreachable statements, and so on). */
  notes: OpenUiProblem[]
  /** Statement count the parser saw. */
  statementCount: number
  /** Component the root resolves to, when it resolved. */
  rootComponent: string | undefined
  /** Tool names this program queries, in the order the parser found them. */
  readTools: string[]
  /** Tool names this program mutates, in the order the parser found them. */
  writeTools: string[]
  /** Parsed result, for callers that need the tree. */
  result: ParseResult
}

/** A parser built once per process over the frozen catalog. */
const parser = createParser(OPENUI_LIBRARY_SCHEMA, OPENUI_LIBRARY_META.root)

/**
 * The literal tool names a program uses, split by statement kind.
 *
 * This is the authoritative answer to "is this call a read or a write", and it
 * is computed here, on the host, because that is where the program is actually
 * parsed. The browser half cannot work it out reliably: the renderer's
 * `toolProvider` carries no statement identity, and its `onParseResult` callback
 * fires in an effect *after* the first queries have already run — so a frame
 * that guessed from it would attribute the very first fetch to the wrong
 * allowlist.
 * @param result - a parse result.
 * @returns the tool names, deduplicated, in parse order.
 */
export function programToolUsage(result: ParseResult): { readTools: string[]; writeTools: string[] } {
  const collect = (statements: readonly { toolAST: unknown }[]): string[] => {
    const names: string[] = []
    for (const statement of statements) {
      const node = statement.toolAST as { k?: string; v?: unknown } | null
      const name = node?.k === 'Str' && typeof node.v === 'string' ? node.v : undefined
      if (name !== undefined && !names.includes(name)) names.push(name)
    }
    return names
  }
  return { readTools: collect(result.queryStatements), writeTools: collect(result.mutationStatements) }
}

/**
 * Validate one OpenUI Lang program against the catalog.
 * @param source - the whole program text.
 * @returns the parse result and the fatal/advisory findings.
 */
export function validateOpenUi(source: string): OpenUiValidation {
  const result = parser.parse(source)
  const problems: OpenUiProblem[] = []
  const notes: OpenUiProblem[] = []

  if (result.meta.incomplete) {
    problems.push({
      code: 'incomplete',
      message:
        'the program is truncated — a string, bracket or call is left open. '
        + 'Close every "(", "[" and "{" and end the final statement with a newline.',
    })
  }

  for (const error of result.meta.errors) {
    const problem = describeError(error, result)
    if (error.severity === 'warning' || !FATAL_CODES.has(error.code)) notes.push(problem)
    else problems.push(problem)
  }

  if (result.root === null && !problems.some(problem => problem.code === 'no-root')) {
    problems.push({
      code: 'no-root',
      message:
        `the program defines no usable root. Every program must start with `
        + `\`${OPENUI_LIBRARY_META.root} = ${OPENUI_LIBRARY_META.rootComponent}(...)\` `
        + 'referencing statements that exist.',
    })
  }

  if (result.meta.unresolved.length > 0) {
    problems.push({
      code: 'unresolved-reference',
      message:
        `${quoteList(result.meta.unresolved)} ${result.meta.unresolved.length === 1 ? 'is' : 'are'} `
        + 'referenced but never defined. Define each name on its own line, or remove the reference.',
    })
  }

  if (result.meta.orphaned.length > 0) {
    notes.push({
      code: 'orphaned',
      message:
        `${quoteList(result.meta.orphaned)} ${result.meta.orphaned.length === 1 ? 'is' : 'are'} `
        + `defined but unreachable from \`${OPENUI_LIBRARY_META.root}\`, so it will not render. `
        + 'Reference it from the root, or delete it.',
    })
  }

  return {
    problems,
    notes,
    statementCount: result.meta.statementCount,
    rootComponent: result.root?.typeName,
    ...programToolUsage(result),
    result,
  }
}

/**
 * Merge a patch into an existing program by statement name, then re-validate.
 * OpenUI's own `mergeStatements` keeps every statement the patch does not
 * restate and garbage-collects whatever the merge leaves unreachable, so a
 * correction costs only the statements that actually change.
 * @param existing - the recorded program.
 * @param patch - statements to add or replace.
 * @returns the merged program text.
 */
export function mergeOpenUi(existing: string, patch: string): string {
  return mergeStatements(existing, patch, OPENUI_LIBRARY_META.root)
}

/**
 * Turn one parser error into an actionable sentence.
 * @param error - the parser's validation error.
 * @param result - the parse result, for the root component name.
 * @returns the phrased problem.
 */
function describeError(error: ValidationError, result: ParseResult): OpenUiProblem {
  const where = error.statementId === undefined ? '' : ` (statement \`${error.statementId}\`)`
  const at = error.path === '' || error.path === undefined ? '' : ` at \`${error.path}\``
  switch (error.code) {
    case 'unknown-component':
      return {
        code: error.code,
        message:
          `\`${error.component}\`${where} is not a component in this library. `
          + `${suggestName(error.component)} Use only names from the catalog in the openui skill.`,
      }
    case 'missing-required':
      return {
        code: error.code,
        message:
          `\`${error.component}\`${where} is missing the required prop${at}. `
          + 'Arguments are positional, so supply every required argument in catalog order.',
      }
    case 'null-required':
      return {
        code: error.code,
        message:
          `\`${error.component}\`${where} passes null for a required prop${at}. `
          + 'Supply a real value; only optional trailing arguments may be omitted.',
      }
    case 'excess-args':
      return {
        code: error.code,
        message:
          `\`${error.component}\`${where} passes more arguments than the catalog defines${at}. `
          + 'Remove the extra arguments — arguments are positional.',
      }
    case 'inline-reserved':
      return {
        code: error.code,
        message:
          `\`${error.component}\`${where} is an inline building block and cannot be placed here${at}. `
          + 'Inline blocks (Text, BoldText, IconText, ImageText, MetricIndicator…) belong inside a card item.',
      }
    case 'no-root':
      return {
        code: error.code,
        message:
          result.root === null
            ? `the program defines no \`${OPENUI_LIBRARY_META.root}\` statement.`
            : `the \`${OPENUI_LIBRARY_META.root}\` statement did not resolve to a component.`,
      }
    default:
      return { code: error.code, message: `${error.component}${where}${at}: ${error.message}` }
  }
}

/**
 * Suggest a catalog name close to a misspelled one, so a typo costs one round
 * trip instead of a search through the component list.
 * @param name - the unknown component name.
 * @returns a suggestion clause, or a short generic reminder.
 */
function suggestName(name: string): string {
  const lowered = name.toLowerCase()
  const near = OPENUI_LIBRARY_META.componentNames.filter(
    candidate => candidate.toLowerCase().includes(lowered) || lowered.includes(candidate.toLowerCase()),
  )
  return near.length > 0 && near.length <= 3
    ? `Did you mean ${quoteList(near)}?`
    : `Known components include ${quoteList(OPENUI_LIBRARY_META.componentNames.slice(0, 8))}…`
}

/**
 * Render a name list as backticked, comma-separated text.
 * @param names - the names to render.
 * @returns the rendered list.
 */
function quoteList(names: readonly string[]): string {
  return names.map(value => `\`${value}\``).join(', ')
}
