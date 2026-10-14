/**
 * The pure card descriptor: what survives replay, what a nested dispatch can
 * still address, and how a program is read out of arguments that are still
 * arriving.
 */

import { describe, expect, it } from 'vitest'
import {
  OPENUI_TOOL_NAME,
  openUiMetaFrom,
  openUiMetaFromArgs,
  openUiPathFromText,
  openUiSourcePrefix,
  type OpenUiMeta,
} from '../src/meta.ts'
import { formatActionSubmission, type FrameAction } from '../src/client/conversation.ts'

/** A well-formed descriptor. */
const META: OpenUiMeta = {
  kind: 'openui',
  render: 'openui-lang',
  source: 'root = Stack([a])\na = TextContent("x")\n',
  title: 'Demo',
  mode: 'wide',
  path: '/tmp/dsh-openui/demo.openui',
  libraryId: '@openuidev/react-ui/genui-lib@0.18.0',
  readTools: ['demo_files'],
  writeTools: [],
}

describe('the wire name', () => {
  it('is the tool and the toolview key', () => {
    expect(OPENUI_TOOL_NAME).toBe('openui')
  })
})

describe('openUiMetaFrom', () => {
  it('round-trips a descriptor', () => {
    expect(openUiMetaFrom(META)).toEqual(META)
  })

  it('declines a foreign meta shape rather than throwing', () => {
    expect(openUiMetaFrom({ kind: 'visualize', render: 'a2ui' })).toBeUndefined()
    expect(openUiMetaFrom(null)).toBeUndefined()
    expect(openUiMetaFrom('openui')).toBeUndefined()
  })

  it('declines a descriptor missing the program', () => {
    expect(openUiMetaFrom({ ...META, source: '' })).toBeUndefined()
    expect(openUiMetaFrom({ ...META, source: undefined })).toBeUndefined()
  })

  it('declines an unknown width instead of guessing one', () => {
    expect(openUiMetaFrom({ ...META, mode: 'huge' })).toBeUndefined()
  })

  it('defaults the tool lists for a log written before they existed', () => {
    const { readTools, writeTools, ...rest } = META
    expect(readTools).toEqual(['demo_files'])
    expect(writeTools).toEqual([])
    const narrowed = openUiMetaFrom(rest)
    // Empty read list means "unknown", so the frame declines to the write
    // allowlist rather than treating an unattributable call as a read.
    expect(narrowed?.readTools).toEqual([])
    expect(narrowed?.writeTools).toEqual([])
  })

  it('round-trips the tool lists it was given', () => {
    expect(openUiMetaFrom(META)?.readTools).toEqual(['demo_files'])
  })

  it('tolerates a missing library id from an older log', () => {
    const { libraryId, ...rest } = META
    expect(libraryId).toBeDefined()
    expect(openUiMetaFrom(rest)?.libraryId).toBe('')
  })
})

describe('openUiMetaFromArgs', () => {
  it('rebuilds a create from the call arguments', () => {
    const args = JSON.stringify({ title: 'Sales', mode: 'wide', source: META.source })
    const meta = openUiMetaFromArgs(args)
    expect(meta?.title).toBe('Sales')
    expect(meta?.mode).toBe('wide')
    expect(meta?.source).toBe(META.source)
  })

  it('defaults the title and width', () => {
    const meta = openUiMetaFromArgs(JSON.stringify({ source: META.source }))
    expect(meta?.title).toBe('OpenUI')
    expect(meta?.mode).toBe('inline')
  })

  it('declines an update, which needs the card it addresses', () => {
    expect(openUiMetaFromArgs(JSON.stringify({ action: 'update', patch: 'a = TextContent("x")' }))).toBeUndefined()
  })

  it('declines a half-arrived argument object', () => {
    expect(openUiMetaFromArgs('{"title":"T","source":"root = Stack(')).toBeUndefined()
    expect(openUiMetaFromArgs('')).toBeUndefined()
    expect(openUiMetaFromArgs(undefined)).toBeUndefined()
  })
})

describe('openUiSourcePrefix', () => {
  it('reads the program out of an unterminated argument object', () => {
    expect(openUiSourcePrefix('{"title":"T","mode":"wide","source":"root = Stack([a])'))
      .toBe('root = Stack([a])')
  })

  it('decodes escapes as they arrive', () => {
    expect(openUiSourcePrefix('{"source":"a = TextContent(\\"hi\\")\\nb = TextContent(\\"yo\\")'))
      .toBe('a = TextContent("hi")\nb = TextContent("yo")')
  })

  it('stops at a half-written unicode escape instead of emitting a replacement', () => {
    expect(openUiSourcePrefix('{"source":"ok\\u00')).toBe('ok')
  })

  it('reads a patch, which is how an update streams', () => {
    expect(openUiSourcePrefix('{"action":"update","patch":"title = TextContent(\\"x\\")'))
      .toBe('title = TextContent("x")')
  })

  it('prefers the key the model is currently writing', () => {
    const raw = '{"patch":"P","source":"S"'
    // `patch` appears first in the text, so it is the one still streaming.
    expect(openUiSourcePrefix(raw)).toBe('P')
  })

  it('yields nothing before the value starts arriving', () => {
    expect(openUiSourcePrefix('{"title":"T","source":')).toBeUndefined()
    expect(openUiSourcePrefix('{"title":"T"')).toBeUndefined()
    expect(openUiSourcePrefix(undefined)).toBeUndefined()
  })
})

describe('openUiPathFromText', () => {
  it('recovers the path a nested create reported', () => {
    const content = [{ type: 'text', text: 'Rendered "Demo" as an OpenUI surface (128 bytes; copy at /tmp/x.openui). The user sees it.' }]
    expect(openUiPathFromText(content)).toBe('/tmp/x.openui')
  })

  it('declines text that is not the tool confirmation', () => {
    expect(openUiPathFromText([{ type: 'text', text: 'something else' }])).toBeUndefined()
    expect(openUiPathFromText(undefined)).toBeUndefined()
  })
})

describe('formatActionSubmission', () => {
  const action: FrameAction = {
    type: 'continue_conversation',
    params: {},
    humanFriendlyMessage: 'Submit',
    formState: { name: 'Ada', seats: 2 },
    formName: 'contact',
  }

  it('names the card and carries the form values', () => {
    const text = formatActionSubmission(action, 'Contact Us')
    expect(text).toContain('Contact Us')
    expect(text).toContain('form "contact"')
    expect(text).toContain('Submit')
    expect(text).toContain('name: Ada')
    expect(text).toContain('seats: 2')
  })

  it('falls back to the action type when the program gave no message', () => {
    const text = formatActionSubmission({ ...action, humanFriendlyMessage: '' }, 'Demo')
    expect(text).toContain('continue_conversation')
  })

  it('omits the value block when the form submitted nothing', () => {
    const text = formatActionSubmission({ ...action, formState: null }, 'Demo')
    expect(text.split('\n')).toHaveLength(1)
  })
})
