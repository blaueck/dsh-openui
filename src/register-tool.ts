/**
 * The model-facing `openui_component` tool: register, update, remove or list the
 * project-local components the `openui` tool expands.
 *
 * This is the extensibility seam. The catalog itself is generated at build time
 * and cannot grow at runtime, so a new component is a name plus a **template** —
 * one OpenUI Lang expression over the existing catalog, with `{{prop}}` holes
 * for its positional arguments. Registration persists the manifest under the DSH
 * profile, regenerates the incremental skill, and invalidates the skill catalog
 * so the current session and every later one can discover it.
 *
 * A definition is code in exactly one sense: it is persisted and reused. It
 * cannot execute anything the model could not already write in a program, which
 * is why registering one does not widen the card's sandbox.
 *
 * @module @blaueck/dsh-openui/register-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateComponentDefinition } from './component-validation.ts'
import {
  OPENUI_COMPONENT_TOOL_NAME,
  PROP_TYPES,
  signatureOf,
  type ComponentProp,
  type ComponentPropType,
} from './registry.ts'
import type { ComponentStore } from './store.ts'

const DESCRIPTION =
  'Register a reusable component for the `openui` tool. Two kinds: '
  + 'a `template` is one OpenUI Lang expression over the built-in catalog with '
  + '`{{prop}}` holes (expanded inline; cheap, no new runtime), and `code` is a real '
  + 'React component — a JavaScript function expression returning React elements, '
  + 'with optional CSS — which is added to the card runtime at render time and can '
  + 'introduce genuinely new UI, styling and local interaction. Code components are '
  + 'disabled unless the profile enables `allowCodeComponents`. '
  + 'Props are positional, in the order given. Registration is saved in this DSH '
  + 'profile\'s config directory and is available in every later session; the plugin '
  + 'also regenerates an `openui-components` skill that documents signatures, '
  + 'implementations and examples. '
  + 'For `code`: no JSX; use `React.createElement` (or `React.createElement(...)` '
  + 'aliased), `React.useState` and friends. The function is called as '
  + '`fn(props, context)`; `context.renderNode(value)` renders a nested catalog '
  + 'element, and `window.__dshOpenUI.toAssistant(text)` sends a message back to you. '
  + 'Only register when the user asks for a reusable component or approves one. '
  + 'Example: name "StatCard", props [{name:"label",type:"string",required:true}, '
  + '{name:"count",type:"number",required:true}], code '
  + '`(props) => React.createElement("div", { style: { border: "1px solid var(--openui-border-default)", borderRadius: 12, padding: 16 } }, React.createElement("div", { style: { fontSize: 12, opacity: 0.7 } }, props.label), React.createElement("div", { style: { fontSize: 28, fontWeight: 600 } }, props.count))`. '
  + 'Use action "update" to change an existing component, "remove" to delete it, and '
  + '"list" to inspect what is registered.'

/** What one call reports back, and what the model reads. */
interface ComponentToolOutput {
  action: 'register' | 'update' | 'remove' | 'list'
  name: string
  signature: string
  path: string
  skillPath: string
  count: number
  components: string[]
  warnings: string[]
}

/**
 * Build the `openui_component` tool definition.
 * @param store - the profile registry this tool owns.
 * @param options - whether React code components may be registered.
 * @param onChanged - invalidates the skill catalog after a write.
 * @returns the tool definition to register on `ctx.tools`.
 */
export function openUiComponentTool(
  store: ComponentStore,
  options: { readonly allowCode: boolean },
  onChanged: () => void,
): ToolDefinition {
  return defineTool({
    name: OPENUI_COMPONENT_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: ['register', 'update', 'remove', 'list'],
        description:
          '`register` (default) creates a component, `update` replaces an existing one, '
          + '`remove` deletes it, and `list` reports what this profile holds.',
      },
      name: {
        type: 'string',
        description: 'PascalCase component name, as programs will call it, e.g. `FlightCard`. Required except for `list`.',
      },
      description: {
        type: 'string',
        description: 'One sentence on when to use the component; shown in the generated skill.',
      },
      props: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            type: { type: 'string', required: true, enum: [...PROP_TYPES] },
            required: { type: 'boolean' },
          },
        },
        description:
          'Positional arguments, in call order. `type` is one of string, number, boolean, '
          + 'json, array, children, component, any; `required` defaults to false, and only '
          + 'trailing optional arguments may be omitted.',
      },
      template: {
        type: 'string',
        description:
          'Composition kind: one OpenUI Lang expression over the built-in catalog, with '
          + '`{{propName}}` holes. It cannot declare statements, `Query()`, `Mutation()` or '
          + '`$state`; pass those values in as arguments. Mutually exclusive with `code`.',
      },
      code: {
        type: 'string',
        description:
          'React kind: a JavaScript function expression `(props, context) => React element`, '
          + 'evaluated inside the sandboxed card frame. `React` is in scope; JSX is not. '
          + 'Mutually exclusive with `template`. Requires the profile to enable '
          + '`allowCodeComponents`.',
      },
      css: {
        type: 'string',
        description:
          'React kind only: optional stylesheet injected once into the card frame. Scope '
          + 'selectors yourself (for example with a class the component adds).',
      },
      example: {
        type: 'string',
        description:
          'Optional complete program demonstrating the component. It is validated and shown '
          + 'in the generated skill; one short example is strongly recommended.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['register', 'update', 'remove', 'list'] },
          name: { type: 'string', required: true },
          signature: { type: 'string', required: true },
          path: { type: 'string', required: true },
          skillPath: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          components: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const warningLine = value.warnings.length === 0
          ? ''
          : `\nNotes: ${value.warnings.map(warning => `- ${warning}`).join('\n')}`
        switch (value.action) {
          case 'list':
            return [{
              type: 'text',
              text: value.components.length === 0
                ? `No OpenUI components are registered in this profile. (${value.path})`
                : `Registered OpenUI components in this profile (${value.count}):\n`
                  + value.components.map(component => `- ${component}`).join('\n')
                  + `\nSkill: ${value.skillPath}`
                  + warningLine,
            }]
          case 'remove':
            return [{
              type: 'text',
              text: `Removed \`${value.name}\` from the OpenUI component registry; ${value.count} remain. `
                + `The regenerated skill is at ${value.skillPath}.${warningLine}`,
            }]
          case 'update':
            return [{
              type: 'text',
              text: `Updated \`${value.signature}\` in the OpenUI component registry at ${value.path}; `
                + `it is available in every session in this profile. Load the \`openui-components\` skill `
                + `before using it.${warningLine}`,
            }]
          default:
            return [{
              type: 'text',
              text: `Registered \`${value.signature}\` in the OpenUI component registry at ${value.path}; `
                + `it is available in every session in this profile. Load the \`openui-components\` skill `
                + `before using it.${warningLine}`,
            }]
        }
      },
    },
    // A register/update/remove rewrites shared profile state; only a read may
    // join a parallel group.
    isConcurrencySafe: args => (args.action ?? 'register') === 'list',
    async execute(args): Promise<ComponentToolOutput> {
      const action = (args.action ?? 'register') as ComponentToolOutput['action']
      const skillPath = store.skillPath

      if (action === 'list') {
        const snapshot = await store.load()
        const visible = snapshot.components.filter(
          component => options.allowCode || component.kind === 'template',
        )
        return {
          action,
          name: '',
          signature: '',
          path: store.directory,
          skillPath,
          count: visible.length,
          components: visible.map(component => `${component.kind === 'react' ? 'react' : 'template'} · ${signatureOf(component)} — ${component.description}`),
          warnings: snapshot.problems.map(problem => problem.message),
        }
      }

      const name = required(args.name, 'name', action).trim()
      if (action === 'remove') {
        const removed = await store.remove(name)
        if (!removed) throw new Error(`invalid openui component: \`${name}\` is not registered, so it cannot be removed`)
        onChanged()
        const snapshot = await store.load()
        return {
          action,
          name,
          signature: name,
          path: '',
          skillPath,
          count: snapshot.components.length,
          components: [],
          warnings: [],
        }
      }

      const snapshot = await store.load()
      const props: ComponentProp[] = (args.props ?? []).map(prop => ({
        name: prop.name.trim(),
        type: prop.type as ComponentPropType,
        required: prop.required === true,
      }))
      const validation = validateComponentDefinition({
        name,
        description: required(args.description, 'description', action),
        props,
        ...args.template === undefined ? {} : { template: args.template },
        ...args.code === undefined ? {} : { code: args.code },
        ...args.css === undefined ? {} : { css: args.css },
        ...args.example === undefined ? {} : { example: args.example },
      }, {
        existing: snapshot.components,
        mode: action,
        maxComponents: store.maxComponents,
        allowCode: options.allowCode,
      })

      if (validation.component === undefined) {
        throw new Error(`invalid openui component \`${name}\` — ${validation.problems.length} problem`
          + `${validation.problems.length === 1 ? '' : 's'}:\n`
          + validation.problems.map(problem => `- ${problem.code}: ${problem.message}`).join('\n')
          + `\nA template is an OpenUI Lang composition such as `
          + `\`Card([CardHeader({{title}}, {{subtitle}}), TextContent({{body}})])\`; `
          + 'a code component is a React function expression. '
          + 'The OpenUI language and catalog are in the `openui` skill.')
      }

      const path = await store.save(validation.component)
      onChanged()
      return {
        action,
        name: validation.component.name,
        signature: signatureOf(validation.component),
        path,
        skillPath,
        count: snapshot.components.length + (action === 'register' ? 1 : 0),
        components: [],
        warnings: validation.warnings.map(warning => warning.message),
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'OpenUI component',
      kind: 'other',
    }),
    presentResult(_args, result) {
      if (result.isError) return undefined
      return { card: 'generic', title: 'OpenUI component' }
    },
  })
}

/**
 * Take one argument the chosen action cannot run without.
 * @param value - the raw argument.
 * @param field - the parameter name, as the model wrote it.
 * @param action - the action that requires it.
 * @returns the raw value.
 * @throws Error naming the missing parameter.
 */
function required(value: string | undefined, field: string, action: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`invalid openui component: \`${field}\` is required when action is "${action}"`)
  }
  return value
}
