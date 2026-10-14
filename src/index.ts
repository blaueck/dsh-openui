/**
 * dsh-openui, node half: registers the `openui` tool on `ctx.tools` and the
 * bundled `openui` skill on `ctx.skills`.
 *
 * The browser half (`src/client/`) registers the sandboxed OpenUI card under the
 * same wire name; a client without it falls back to the tool's generic result
 * text — the documented render-intent degradation, so TUI and headless surfaces
 * keep working.
 *
 * @module @blaueck/dsh-openui
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { openUiTool } from './tool.ts'
import { openUiSkillProvider } from './skill.ts'
import { OpenUiRemote } from './host/remote.ts'

export { OPENUI_TOOL_NAME } from './meta.ts'
export {
  openUiMetaFrom,
  openUiMetaFromArgs,
  openUiSourcePrefix,
  openUiPathFromText,
  type OpenUiMeta,
  type OpenUiMode,
  type OpenUiAction,
} from './meta.ts'
export { OPENUI_LIBRARY_META, validateOpenUi, mergeOpenUi, type OpenUiValidation } from './library-spec.ts'

/** Cordis plugin name. */
export const name = '@blaueck/dsh-openui'
/** Required services: the tool registry, the skill registry, and the fs seam. */
export const inject = ['tools', 'skills', 'fs']

/** Deployment configuration. */
export interface Config {
  /**
   * Size ceiling in bytes for one OpenUI program. A program past it is rejected
   * at execute time with guidance to downsample the data it inlines; the same
   * ceiling bounds what one call adds to the session log.
   */
  maxSourceBytes: number
  /**
   * Tools a card's `Query()` may call, by exact wire name. **Empty by default**:
   * until a tool is named here, every card-initiated read is refused. A card
   * re-runs its queries on its own, and the results never reach the session log,
   * so this list is the operator's decision rather than a default.
   */
  allowedTools: string[]
  /**
   * Tools a card's `Mutation()` may call, by exact wire name. **Empty by
   * default.** A mutation is triggered by a user click rather than a model turn,
   * and still runs through the tool pipeline, so the session's approval policy
   * decides whether it prompts.
   */
  writableTools: string[]
  /** Byte ceiling on one value a card's tool call may return. */
  maxResultBytes: number
  /** Wall-clock ceiling on one card-initiated tool call, in milliseconds. */
  callTimeoutMs: number
}

/** Schemastery configuration validated by the Loader. */
export const Config: z<Config> = z.object({
  maxSourceBytes: z.natural().default(256_000),
  // Both allowlists default to empty on purpose; see {@link Config}.
  allowedTools: z.array(z.string()).default([]),
  writableTools: z.array(z.string()).default([]),
  maxResultBytes: z.natural().default(256_000),
  callTimeoutMs: z.natural().default(20_000),
})

/**
 * Register the tool, the bundled skill provider, and the card Remote surface.
 * @param ctx - registrant context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(openUiTool(ctx, config.maxSourceBytes))
  ctx.skills.registerProvider(() => openUiSkillProvider)
  // Constructing the service registers it on this context and binds the same key
  // to the Typert Gateway, which is what lets a card in the browser reach it.
  // Cordis owns the instance, so it is deliberately not retained here.
  new OpenUiRemote(ctx, {
    allowedTools: config.allowedTools,
    writableTools: config.writableTools,
    maxResultBytes: config.maxResultBytes,
    callTimeoutMs: config.callTimeoutMs,
  })
}
