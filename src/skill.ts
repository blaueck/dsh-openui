/**
 * Bundled `openui` skill provider: the authoring contract the model loads
 * before its first `openui` call. The body is generated from the installed
 * OpenUI library by `scripts/gen-library.mjs`, so the component catalog it
 * teaches is exactly the catalog the tool validates against.
 *
 * Mirrors the official bundled-skill provider shape — one bundled candidate
 * whose body ships in this package's `skills/`.
 *
 * @module @blaueck/dsh-openui/skill
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'dsh-openui'
const SKILL_BODY_URL = new URL('../skills/openui-skill.md', import.meta.url)

/** Absolute path of the skill body, for agents that cannot load skills. */
export const SKILL_BODY_PATH = fileURLToPath(SKILL_BODY_URL)

/** Absolute directory the skill body's relative references resolve against. */
export const SKILL_RESOURCE_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

const RESOURCE_BASE = {
  kind: 'directory',
  path: SKILL_RESOURCE_DIR,
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION =
  'Authoring contract for the openui tool, which renders OpenUI Lang as a live '
  + 'interactive card in the conversation: dashboards, tables, charts, forms, '
  + 'step-by-step explainers, and product-screen mockups. Load before the first '
  + 'openui call in a session — it defines the statement grammar, the component '
  + 'catalog with positional argument order, interactive $variables and form '
  + 'bindings, and the actions a card can send back.'

const CANDIDATE: SkillCandidate = {
  name: 'openui',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

/** The bundled provider registered on `ctx.skills`. */
export const openUiSkillProvider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}
