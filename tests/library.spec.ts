/**
 * The validation contract the `openui` tool enforces: a program that renders,
 * a program that does not, and the merge a later correction rides on.
 */

import { describe, expect, it } from 'vitest'
import { OPENUI_LIBRARY_META, mergeOpenUi, programToolUsage, validateOpenUi } from '../src/library-spec.ts'

const GOOD = [
  'root = Card([title, tbl])',
  'title = TextContent("Top Languages", "large-heavy")',
  'tbl = Table([Col("Language", langs)])',
  'langs = ["Python", "Go"]',
  '',
].join('\n')

/** Codes of the fatal findings, for compact assertions. */
function codes(source: string): string[] {
  return validateOpenUi(source).problems.map(problem => problem.code)
}

/** Codes of the advisory findings. */
function noteCodes(source: string): string[] {
  return validateOpenUi(source).notes.map(note => note.code)
}

describe('the generated catalog', () => {
  it('carries the official component library', () => {
    expect(OPENUI_LIBRARY_META.componentCount).toBeGreaterThan(50)
    expect(OPENUI_LIBRARY_META.componentNames).toContain('Card')
    expect(OPENUI_LIBRARY_META.componentNames).toContain('Table')
    expect(OPENUI_LIBRARY_META.componentNames).toContain('BarChart')
    expect(OPENUI_LIBRARY_META.rootComponent).toBe('Card')
    expect(OPENUI_LIBRARY_META.libraryId).toMatch(/@openuidev\/browser-bundle@/u)
  })
})

describe('validateOpenUi', () => {
  it('accepts a well-formed program and resolves its root', () => {
    const validation = validateOpenUi(GOOD)
    expect(validation.problems).toEqual([])
    expect(validation.rootComponent).toBe('Card')
    expect(validation.statementCount).toBe(4)
  })

  it('rejects an unknown component', () => {
    expect(codes('root = Card([title])\ntitle = Nope("x")\n')).toContain('unknown-component')
  })

  it('rejects a program with no root', () => {
    expect(codes('a = TextContent("x")\n')).toContain('no-root')
  })

  it('rejects a dangling reference', () => {
    expect(codes('root = Card([missing])\n')).toContain('unresolved-reference')
  })

  it('rejects a truncated program', () => {
    expect(codes('root = Card([title])\ntitle = TextContent("x"\n')).toContain('incomplete')
  })

  it('reports an unreachable statement as advisory, not fatal', () => {
    const source = 'root = Card([a])\na = TextContent("x")\nb = TextContent("y")\n'
    expect(codes(source)).toEqual([])
    expect(noteCodes(source)).toContain('orphaned')
  })

  it('names the offending statement so the model can fix it', () => {
    const problems = validateOpenUi('root = Card([title])\ntitle = Nope("x")\n').problems
    const unknown = problems.find(problem => problem.code === 'unknown-component')
    expect(unknown?.message).toContain('Nope')
    expect(unknown?.message).toContain('title')
  })
})

describe('mergeOpenUi', () => {
  it('keeps statements the patch does not restate and drops what it orphans', () => {
    const merged = mergeOpenUi(
      'root = Card([a])\na = TextContent("x", "small")\nb = TextContent("y")\n',
      'root = Card([a, b])\n',
    )
    // The restated root and the newly reachable `b` survive; `a` is unchanged.
    expect(merged).toContain('a = TextContent("x", "small")')
    expect(merged).toContain('b = TextContent("y")')
    expect(validateOpenUi(merged).problems).toEqual([])
  })

  it('replaces a restated statement', () => {
    const merged = mergeOpenUi(
      'root = Card([a])\na = TextContent("before")\n',
      'a = TextContent("after")\n',
    )
    expect(merged).toContain('after')
    expect(merged).not.toContain('before')
  })

  it('produces a program the validator accepts', () => {
    const merged = mergeOpenUi(GOOD, 'title = TextContent("Updated", "large-heavy")\n')
    expect(validateOpenUi(merged).problems).toEqual([])
  })
})

describe('programToolUsage', () => {
  it('splits the program\'s tool names by statement kind', () => {
    const source = [
      'root = Card([tbl, btn])',
      'tbl = Table([Col("Path", data.paths)])',
      'data = Query("glob", { pattern: "*.ts" }, { paths: [] })',
      'btn = Button("Refresh", Action([@Run(save)]))',
      'save = Mutation("write", { path: "out.txt" })',
      '',
    ].join('\n')
    const usage = programToolUsage(validateOpenUi(source).result)
    expect(usage.readTools).toEqual(['glob'])
    expect(usage.writeTools).toEqual(['write'])
  })

  it('is empty for a program that never fetches', () => {
    const usage = validateOpenUi(GOOD).result && programToolUsage(validateOpenUi(GOOD).result)
    expect(usage).toEqual({ readTools: [], writeTools: [] })
  })

  it('reaches the caller through validateOpenUi', () => {
    const validation = validateOpenUi('root = Card([t])\nt = TextContent("" + @Count(data.paths))\ndata = Query("glob", {}, { paths: [] })\n')
    expect(validation.readTools).toEqual(['glob'])
    expect(validation.writeTools).toEqual([])
  })
})
