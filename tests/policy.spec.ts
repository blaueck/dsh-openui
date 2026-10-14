/**
 * The two decisions a card-initiated tool call turns on: may this card call this
 * tool, and is the answer small enough to render. Both are pure, so they are
 * tested directly rather than through a Cordis service.
 */

import { describe, expect, it } from 'vitest'
import { checkResultSize, decideToolCall, type ToolPolicy } from '../src/host/policy.ts'

/** A deployment that allows one read tool and one write tool. */
const POLICY: ToolPolicy = {
  allowedTools: ['glob', 'grep'],
  writableTools: ['write'],
  maxResultBytes: 1024,
}

/** A deployment that has authorised nothing, which is the shipped default. */
const CLOSED: ToolPolicy = { allowedTools: [], writableTools: [], maxResultBytes: 1024 }

describe('decideToolCall', () => {
  it('refuses everything until an operator names a tool', () => {
    // Both lists ship empty; this is the default posture, not an oversight.
    expect(decideToolCall(CLOSED, 'query', 'glob').allowed).toBe(false)
    expect(decideToolCall(CLOSED, 'mutation', 'write').allowed).toBe(false)
  })

  it('allows a read tool for a Query and a write tool for a Mutation', () => {
    expect(decideToolCall(POLICY, 'query', 'glob')).toEqual({ allowed: true })
    expect(decideToolCall(POLICY, 'query', 'grep')).toEqual({ allowed: true })
    expect(decideToolCall(POLICY, 'mutation', 'write')).toEqual({ allowed: true })
  })

  it('refuses a Query for a tool only authorised for writing, and says which to use', () => {
    const verdict = decideToolCall(POLICY, 'query', 'write')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    expect(verdict.reason).toContain('`allowedTools`')
    expect(verdict.reason).toContain('writableTools')
    expect(verdict.reason).toContain('Mutation()')
  })

  it('refuses a Mutation for a tool only authorised for reading, and says which to use', () => {
    const verdict = decideToolCall(POLICY, 'mutation', 'glob')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    expect(verdict.reason).toContain('`writableTools`')
    expect(verdict.reason).toContain('Query()')
  })

  it('refuses an unknown tool without inventing a hint', () => {
    const verdict = decideToolCall(POLICY, 'query', 'bash')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) throw new Error('unreachable')
    expect(verdict.reason).toContain('`bash`')
    expect(verdict.reason).toContain('`allowedTools`')
    expect(verdict.reason).not.toContain('use `')
  })

  it('does not let a write list widen reads', () => {
    // The whole point of two lists: authorising a write must not authorise a
    // card to run it unattended on a refresh.
    const policy: ToolPolicy = { allowedTools: [], writableTools: ['write'], maxResultBytes: 1024 }
    expect(decideToolCall(policy, 'query', 'write').allowed).toBe(false)
  })
})

describe('checkResultSize', () => {
  it('accepts a value at or under the ceiling', () => {
    expect(checkResultSize(POLICY, 'glob', { paths: [] })).toBeUndefined()
    // A 1024-byte JSON payload is exactly at the limit and must pass.
    const exact = 'x'.repeat(1022)
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(1024)
    expect(checkResultSize(POLICY, 'glob', exact)).toBeUndefined()
  })

  it('refuses a value over the ceiling and names the tool', () => {
    const reason = checkResultSize(POLICY, 'glob', 'x'.repeat(4096))
    expect(reason).toBeDefined()
    expect(reason).toContain('`glob`')
    expect(reason).toContain('ceiling')
    expect(reason).toContain('Narrow the query')
  })

  it('measures the encoded bytes rather than the character count', () => {
    // Multibyte text must not slip past a byte ceiling.
    const reason = checkResultSize(POLICY, 'glob', '中'.repeat(400))
    expect(reason).toBeDefined()
  })
})
