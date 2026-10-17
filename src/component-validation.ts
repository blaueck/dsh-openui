/**
 * Catalog-level validation for a component definition.
 *
 * `registry.ts` owns the local shape (names, props, code syntax, template holes)
 * and knows nothing about the OpenUI catalog. This module closes the loop:
 *
 * - A `template` component is expanded with one dummy value per declared prop and
 *   parsed by the real catalog parser, so a call to a component that does not
 *   exist or the wrong arity is caught at registration.
 * - A `react` component cannot be executed here; its example is parsed against
 *   the catalog extended with its own props, which checks the call shape and the
 *   rest of the program. The code itself is only compiled, never run.
 *
 * @module @blaueck/dsh-openui/component-validation
 */

import { OPENUI_LIBRARY_META, validateOpenUi } from './library-spec.ts'
import {
  dummyProgramOf,
  normalizeComponent,
  signatureOf,
  type ComponentCandidateInput,
  type ComponentProblem,
  type CustomComponent,
} from './registry.ts'

/** Registry context a registration is checked against. */
export interface DefinitionValidationOptions {
  /** Components already registered in this profile. */
  readonly existing: readonly CustomComponent[]
  /** `register` refuses a name that exists; `update` requires one that does. */
  readonly mode: 'register' | 'update'
  /** Registry size ceiling. */
  readonly maxComponents: number
  /** Whether React code components are enabled. */
  readonly allowCode: boolean
}

/** Outcome of checking one definition. */
export interface DefinitionValidation {
  /** The normalized component, present only when `problems` is empty. */
  readonly component?: CustomComponent
  /** Fatal findings; a registration with any of these is refused. */
  readonly problems: readonly ComponentProblem[]
  /** Advisory findings; they never block. */
  readonly warnings: readonly ComponentProblem[]
}

/**
 * Validate a definition against the local shape and the real catalog.
 * @param candidate - the definition as submitted.
 * @param options - existing registry, mode, size ceiling, code gate.
 * @returns the normalized component and the findings.
 */
export function validateComponentDefinition(
  candidate: ComponentCandidateInput,
  options: DefinitionValidationOptions,
): DefinitionValidation {
  const normalized = normalizeComponent(candidate, { allowCode: options.allowCode })
  if (normalized.component === undefined) return { problems: normalized.problems, warnings: [] }
  const component = normalized.component
  const problems: ComponentProblem[] = []
  const warnings: ComponentProblem[] = []

  if (OPENUI_LIBRARY_META.componentNames.includes(component.name)) {
    problems.push({
      code: 'builtin-name',
      message: `\`${component.name}\` is already a built-in catalog component; choose another name.`,
    })
  }
  const existing = options.existing.find(entry => entry.name === component.name)
  if (options.mode === 'register' && existing !== undefined) {
    problems.push({
      code: 'already-registered',
      message: `\`${component.name}\` is already registered; use action "update" to change it.`,
    })
  }
  if (options.mode === 'update' && existing === undefined) {
    problems.push({
      code: 'not-registered',
      message: `\`${component.name}\` is not registered; use action "register" to create it.`,
    })
  }
  if (options.mode === 'register' && options.existing.length >= options.maxComponents) {
    problems.push({
      code: 'registry-full',
      message: `this profile already holds ${options.existing.length} registered components, the configured maximum. `
        + 'Remove one before registering another.',
    })
  }

  // The candidate joins the registry for this check, so a template may compose
  // over an existing registered component — and a cycle is caught here too.
  const registry = [
    ...options.existing.filter(entry => entry.name !== component.name),
    component,
  ]

  if (component.kind === 'template') {
    const dummy = validateOpenUi(dummyProgramOf(component), registry)
    for (const problem of dummy.problems) {
      problems.push({
        code: `template-${problem.code}`,
        message: `the template does not render as a component: ${problem.message}`,
      })
    }
  }
  if (problems.length > 0) return { problems, warnings }

  if (component.example !== undefined) {
    if (!component.example.includes(`${component.name}(`)) {
      problems.push({
        code: 'example-unused',
        message: `the example does not call \`${component.name}(...)\`; either show a use of it or leave \`example\` out.`,
      })
    } else {
      const example = validateOpenUi(component.example, registry)
      for (const problem of example.problems) {
        problems.push({
          code: `example-${problem.code}`,
          message: `the example does not render: ${problem.message}`,
        })
      }
      if (example.usedComponents.length === 0 && problems.length === 0) {
        warnings.push({
          code: 'example-unused',
          message: `the example never reaches \`${component.name}\` from its root, so it will not demonstrate the component.`,
        })
      }
    }
  } else {
    warnings.push({
      code: 'no-example',
      message: `no \`example\` was given; one short program showing \`${signatureOf(component)}\` helps later sessions use it correctly.`,
    })
  }

  if (component.kind === 'template' && component.template.length > 4000) {
    warnings.push({
      code: 'long-template',
      message: 'the template is long; a registered component is expanded inline at every call site, so every use adds this much program text.',
    })
  }
  if (component.kind === 'react' && component.code.length > 12_000) {
    warnings.push({
      code: 'long-code',
      message: 'the component code is large; it is persisted in the profile, copied into the incremental skill, and evaluated in every card that uses it.',
    })
  }
  if (component.description.length > 400) {
    warnings.push({
      code: 'long-description',
      message: 'the description is long; keep it to one sentence so the skill stays cheap to load.',
    })
  }

  return { component, problems, warnings }
}
