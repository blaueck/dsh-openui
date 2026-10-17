/**
 * Extend the generated catalog schema with registered React components.
 *
 * A `template` component needs no schema entry: it is expanded away before the
 * parser runs. A `react` component is different — its call must survive into the
 * browser, where the frame's own runtime will resolve it, so the host parser has
 * to know its name and positional props. This module builds that schema from the
 * manifests alone. It never looks at the component's code, which is why host-side
 * validation is safe: code is compiled at registration and executed only inside
 * the card frame.
 *
 * @module @blaueck/dsh-openui/schema-extension
 */

import { createParser, type ElementNode, type LibraryJSONSchema, type Parser } from '@openuidev/lang-core'
import schema from './generated/library.schema.json' with { type: 'json' }
import meta from './generated/library-meta.json' with { type: 'json' }
import type { ComponentPropType, CustomComponent, ReactComponent } from './registry.ts'

/** The catalog as shipped, narrowed for the parser. */
export const BASE_LIBRARY_SCHEMA: LibraryJSONSchema = schema as unknown as LibraryJSONSchema

/** Base parser, shared by every program with no React components. */
const baseParser = createParser(BASE_LIBRARY_SCHEMA, meta.root)

/** Parsers keyed by the React definitions they were built for. */
const parserCache = new Map<string, Parser>()
/** Keep a session from pinning an unbounded number of registries in memory. */
const PARSER_CACHE_LIMIT = 16

/**
 * The React components in one registry.
 * @param components - the registry contents.
 * @returns only the `react`-kind entries.
 */
export function reactComponentsOf(components: readonly CustomComponent[]): ReactComponent[] {
  return components.filter((component): component is ReactComponent => component.kind === 'react')
}

/**
 * JSON Schema for one positional prop.
 *
 * `json`, `component` and `children` are intentionally open: the parser only
 * needs to accept the argument expression, and nested component calls are still
 * checked against the catalog tree as a whole. Child arrays are not narrowed to
 * a component union, because the union is generated before a custom component
 * exists and because a code component receives a plain value, not a parsed
 * element tree.
 * @param type - the declared prop type.
 * @returns the schema fragment.
 */
function propSchema(type: ComponentPropType): Record<string, unknown> {
  switch (type) {
    case 'string':
      return { type: 'string' }
    case 'number':
      return { type: 'number' }
    case 'boolean':
      return { type: 'boolean' }
    case 'array':
    case 'children':
      return { type: 'array' }
    case 'component':
    case 'json':
    case 'any':
    default:
      return {}
  }
}

/**
 * Build the catalog schema plus one definition per React component.
 * @param components - the registry contents, or just its React entries.
 * @returns a detached schema; the generated base is never mutated.
 */
export function schemaWithComponents(components: readonly CustomComponent[]): LibraryJSONSchema {
  const react = reactComponentsOf(components)
  if (react.length === 0) return BASE_LIBRARY_SCHEMA

  const extended = structuredClone(BASE_LIBRARY_SCHEMA) as unknown as {
    properties: Record<string, unknown>
    $defs: Record<string, unknown>
  }
  for (const component of react) {
    const properties = Object.fromEntries(component.props.map(prop => [prop.name, propSchema(prop.type)]))
    const required = component.props.filter(prop => prop.required).map(prop => prop.name)
    extended.$defs[component.name] = {
      type: 'object',
      properties,
      ...required.length === 0 ? {} : { required },
      additionalProperties: false,
      description: component.description,
    }
    extended.properties[component.name] = { $ref: `#/$defs/${component.name}` }
  }
  return extended as unknown as LibraryJSONSchema
}

/**
 * A parser for one registry, cached by the React definitions it contains.
 *
 * The cache matters because a session validates one program per card and the
 * registry rarely changes; compiling an 84-component schema per call would be
 * pure waste. `template` components are absent from the key on purpose — they do
 * not change the schema and are expanded before parsing.
 * @param components - the registry contents.
 * @returns the parser to use.
 */
export function parserFor(components: readonly CustomComponent[]): Parser {
  const react = reactComponentsOf(components)
  if (react.length === 0) return baseParser
  const key = JSON.stringify(react.map(component => [component.name, component.props]))
  const cached = parserCache.get(key)
  if (cached !== undefined) return cached
  const parser = createParser(schemaWithComponents(react), meta.root)
  parserCache.set(key, parser)
  if (parserCache.size > PARSER_CACHE_LIMIT) {
    const oldest = parserCache.keys().next().value
    if (oldest !== undefined) parserCache.delete(oldest)
  }
  return parser
}

/**
 * Collect the names a parsed program actually instantiates.
 *
 * A React component can appear anywhere an element can, including inside a
 * `children` array, an object literal or a component prop; walking the parsed
 * tree with a seen-set is both simple and immune to the textual false positives
 * a name scan would produce (a string or a comment containing `MyCard(`).
 * @param root - the parsed root element.
 * @param candidates - the React component names to look for.
 * @returns the names found, in first-use order.
 */
export function usedReactComponents(root: ElementNode | null, candidates: ReadonlySet<string>): string[] {
  const used: string[] = []
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    const record = value as Record<string, unknown>
    if (record['type'] === 'element' && typeof record['typeName'] === 'string') {
      const name = record['typeName']
      if (candidates.has(name) && !used.includes(name)) used.push(name)
    }
    for (const child of Object.values(record)) visit(child)
  }
  visit(root)
  return used
}
