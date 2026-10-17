/**
 * The `openui` skill provider, plus the incremental skill that documents locally
 * registered components.
 *
 * Two candidates:
 *
 * 1. `openui` — the authoring contract generated at build time. Its body is read
 *    from the package and, when the profile has registrations, gets a short
 *    pointer appended so a model that loads only this skill still learns that
 *    the catalog can grow.
 * 2. `openui-components` — generated from the profile registry on demand. It is
 *    a separate skill so the 57 kB authoring contract is not re-read just to see
 *    three local signatures, and so the registry can change without rebuilding
 *    the package.
 *
 * Mirrors the official bundled-skill provider shape. The registry is optional:
 * with custom components disabled, the provider is exactly the bundled one.
 *
 * @module @blaueck/dsh-openui/skill
 */

import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { renderComponentsPointer, renderComponentsSkill } from './registry.ts'
import type { ComponentStore } from './store.ts'

const PROVIDER_NAME = 'dsh-openui'
const SKILL_BODY_URL = new URL('../skills/openui-skill.md', import.meta.url)

/** Name of the generated skill that documents registered components. */
export const COMPONENTS_SKILL_NAME = 'openui-components'

/** Absolute path of the skill body, for agents that cannot load skills. */
export const SKILL_BODY_PATH = fileURLToPath(SKILL_BODY_URL)

/** Absolute directory the skill body's relative references resolve against. */
export const SKILL_RESOURCE_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

const RESOURCE_BASE = {
  kind: 'directory',
  path: SKILL_RESOURCE_DIR,
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const BASE_DESCRIPTION =
  'Authoring contract for the openui tool, which renders OpenUI Lang as a live '
  + 'interactive card in the conversation: dashboards, tables, charts, forms, '
  + 'step-by-step explainers, and product-screen mockups. Load before the first '
  + 'openui call in a session — it defines the statement grammar, the component '
  + 'catalog with positional argument order, interactive $variables and form '
  + 'bindings, and the actions a card can send back. It also names any locally '
  + 'registered components, which the tool expands before rendering.'

const BASE_CANDIDATE: SkillCandidate = {
  name: 'openui',
  description: BASE_DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

/** What the incremental candidate's opaque locator carries. */
interface ComponentsLocator {
  readonly kind: 'components'
}

const COMPONENTS_CANDIDATE: SkillCandidate = {
  name: COMPONENTS_SKILL_NAME,
  description:
    'Locally registered OpenUI components for this DSH profile — names, positional '
    + 'signatures, templates, and examples. Load before using a component that is not '
    + 'in the built-in 84-component catalog.',
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'custom',
  rank: BUNDLED_SKILL_RANK,
  locator: { kind: 'components' } satisfies ComponentsLocator,
}

/**
 * Build the skill provider for one profile.
 * @param store - the profile registry, when custom components are enabled.
 * @param allowCode - whether React code components are active. Disabled code
 *   components stay on disk but are not advertised or documented.
 * @returns the provider to register on `ctx.skills`.
 */
export function openUiSkillProvider(store?: ComponentStore, allowCode = true): SkillProvider {
  /** The components this profile exposes under the current configuration. */
  const visible = async (): Promise<readonly import('./registry.ts').CustomComponent[]> => {
    if (store === undefined) return []
    const components = (await store.load()).components
    return allowCode ? components : components.filter(component => component.kind === 'template')
  }

  return {
    name: PROVIDER_NAME,
    async list(): Promise<SkillCandidate[]> {
      const candidates = [BASE_CANDIDATE]
      if (store !== undefined && (await visible()).length > 0) {
        candidates.push({
          ...COMPONENTS_CANDIDATE,
          resourceBase: { kind: 'directory', path: dirname(store.skillPath) },
        })
      }
      return candidates
    },
    async get(candidate): Promise<SkillDefinition | undefined> {
      if (candidate.name === COMPONENTS_SKILL_NAME) {
        if (store === undefined) return undefined
        const components = await visible()
        if (components.length === 0) return undefined
        return {
          name: COMPONENTS_SKILL_NAME,
          description: COMPONENTS_CANDIDATE.description,
          invocation: INVOCATION,
          provider: PROVIDER_NAME,
          source: 'custom',
          resourceBase: { kind: 'directory', path: dirname(store.skillPath) },
          // Rendered from the gated list rather than read through `store.skill()`:
          // the file on disk mirrors the whole registry, including code components
          // an operator has turned off.
          content: renderComponentsSkill(components),
        }
      }
      if (candidate.name !== BASE_CANDIDATE.name) return undefined
      const base = await readFile(SKILL_BODY_URL, 'utf8')
      const pointer = renderComponentsPointer(await visible())
      return {
        name: BASE_CANDIDATE.name,
        description: BASE_DESCRIPTION,
        invocation: INVOCATION,
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: RESOURCE_BASE,
        content: pointer.length === 0 ? base : `${base.trimEnd()}\n${pointer}`,
      }
    },
  }
}
