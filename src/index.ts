/**
 * dsh-openui, node half: registers the `openui` tool, the `openui_component`
 * registry tool, the bundled `openui` skill (plus the generated
 * `openui-components` skill) on `ctx.skills`, and the card Remote surface.
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
import { openUiComponentTool } from './register-tool.ts'
import { MAX_COMPONENTS } from './registry.ts'
import { ComponentStore, resolveComponentsDirectory } from './store.ts'
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
export {
  OPENUI_COMPONENT_TOOL_NAME,
  PROP_TYPES,
  expandProgram,
  signatureOf,
  renderComponentsSkill,
  renderComponentsPointer,
  componentFromFile,
  parseComponentSnapshot,
  normalizeComponent,
  type ComponentProp,
  type ComponentPropType,
  type ComponentKind,
  type TemplateComponent,
  type ReactComponent,
  type CustomComponent,
  type Expansion,
  type ComponentProblem,
} from './registry.ts'

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
  /**
   * Whether the `openui_component` registry tool is available. **On by default**
   * because it is the plugin's extensibility seam, and because a registration is
   * a logged tool call the user can see; set it to `false` to pin the catalog to
   * the built-in 84 components and ignore any registry already on disk.
   */
  customComponents: boolean
  /**
   * Whether a registration may ship a **React component** as code.
   *
   * **Off by default.** A code component is evaluated inside the sandboxed card
   * frame, where it can render arbitrary markup and CSS and run local
   * interactions. The frame is an opaque origin with no session and a one-origin
   * network policy, but code can still forge card actions (turning them into user
   * turns) and fetch images from any https origin, so this is an operator
   * decision rather than a default. `false` leaves existing code components on
   * disk but hides them from the tool, the skill, and the browser half; template
   * components keep working.
   */
  allowCodeComponents: boolean
  /**
   * Registry directory. Empty means `<DSH_PROFILE_DIR>/openui/components`; a
   * relative path resolves against the profile directory. Component manifests
   * and the generated `openui-components` skill live there, outside the
   * workspace, so they outlive one session and are shared by the whole profile.
   */
  componentsDir: string
  /** Maximum number of registered components one profile may hold. */
  maxComponents: number
}

/** Schemastery configuration validated by the Loader. */
export const Config: z<Config> = z.object({
  maxSourceBytes: z.natural().default(256_000),
  // Both allowlists default to empty on purpose; see {@link Config}.
  allowedTools: z.array(z.string()).default([]),
  writableTools: z.array(z.string()).default([]),
  maxResultBytes: z.natural().default(256_000),
  callTimeoutMs: z.natural().default(20_000),
  customComponents: z.boolean().default(true),
  allowCodeComponents: z.boolean().default(false),
  componentsDir: z.string().default(''),
  maxComponents: z.natural().default(MAX_COMPONENTS),
})

/**
 * Register the tools, the skill providers, and the card Remote surface.
 * @param ctx - registrant context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // The desktop host does not export DSH_PROFILE_DIR into its own process, so
  // ask the live HMR service for the profile root it watches. This is what makes
  // the default registry land in the profile that is actually running rather
  // than in the fallback `profiles/default` directory.
  const hmr = ctx.get('hmr') as { baseDir?: unknown } | undefined
  const profileDir = typeof hmr?.baseDir === 'string' ? hmr.baseDir : undefined
  const store = config.customComponents
    ? new ComponentStore({
      directory: resolveComponentsDirectory(config.componentsDir, process.env, profileDir),
      maxComponents: config.maxComponents,
    })
    : undefined

  ctx.tools.register(openUiTool(ctx, config.maxSourceBytes, store, config.allowCodeComponents))

  // The skill provider owns the invalidation control. The registration tool has
  // to reach it so a component registered in this session is listed by
  // `ctx.skills` immediately, not only in the next session.
  let invalidateSkills: () => void = () => undefined
  ctx.skills.registerProvider((control) => {
    invalidateSkills = () => {
      try {
        control.invalidate()
      } catch {
        // A disposed registration cannot notify anyone; the catalog is gone
        // with it, so there is nothing useful to do here.
      }
    }
    return openUiSkillProvider(store, config.allowCodeComponents)
  })

  if (store !== undefined) {
    ctx.tools.register(openUiComponentTool(
      store,
      { allowCode: config.allowCodeComponents },
      () => invalidateSkills(),
    ))
  }

  // Constructing the service registers it on this context and binds the same key
  // to the Typert Gateway, which is what lets a card in the browser reach it.
  // Cordis owns the instance, so it is deliberately not retained here.
  new OpenUiRemote(ctx, {
    allowedTools: config.allowedTools,
    writableTools: config.writableTools,
    maxResultBytes: config.maxResultBytes,
    callTimeoutMs: config.callTimeoutMs,
    // The browser half expands registered components before posting a program
    // into the frame. The registry is read per card mount, so a component
    // registered mid-session reaches the very next card.
    loadComponents: async () => {
      if (store === undefined) return []
      const components = (await store.load()).components
      return config.allowCodeComponents
        ? components
        : components.filter(component => component.kind === 'template')
    },
  })
}
