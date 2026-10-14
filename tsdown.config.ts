/**
 * tsdown preset for dsh-openui: an ESM node half with declarations plus a
 * browser half (lib/client.js) wrapped for the harness client-plugin loader.
 *
 * The node half keeps `@deepseek-ai/schemastery` unbundled because the Loader
 * validates the plugin's `Config` schema and must see its own schemastery
 * instance; `@openuidev/lang-core` is bundled in so the installed package is
 * self-contained. All `@deepseek-ai/*` packages are type-only imports there
 * and erase at build time.
 *
 * The browser half keeps only the platform module table entries external
 * (React and Cordis); everything else is inlined. The OpenUI renderer itself
 * is never bundled — the card frame loads it from the pinned CDN at render
 * time, which is what keeps `lib/client.js` small.
 *
 * The Typert face artifacts (`lib/typert.host.*`, `lib/typert.remote-client.*`)
 * are NOT produced here: `pnpm run gen:typert` (scripts/gen-typert.mjs) generates
 * them before tsdown runs, which is also what lets the browser half resolve its
 * own `dsh-openui/remote` import. Because those files live in `lib/`,
 * neither config may clean the output directory — `pnpm run clean` does that
 * explicitly, before generation.
 */
import type { UserConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

const PLUGIN_ID = '@blaueck/dsh-openui'

/** Module specifiers the dsh web shell shares into its frozen module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
] as const

export default [
  {
    entry: { index: 'src/index.ts', protocol: 'src/protocol.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    // `lib/` also holds the generated Typert artifacts; `pnpm run clean` (run
    // before gen:typert) is the only thing that may remove them.
    clean: false,
    deps: {
      // The Loader validates this plugin's `Config` schema and must see its own
      // schemastery instance. `@deepseek-ai/dsh-typert-protocol` stays external
      // so exactly one copy of `TypertRemoteService` (and of the Cordis `Service`
      // base it extends) exists in the host. `@openuidev/lang-core` is a runtime
      // dependency that is inlined instead, so the package carries its own parser.
      neverBundle: [
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-typert-protocol',
      ],
      alwaysBundle: ['@openuidev/lang-core'],
    },
    plugins: [
      // Lowering, not generation. `@Remote(...)` is a standard decorator, and
      // rolldown leaves decorator syntax untouched, so without this plugin the
      // node half ships literal `@Remote("call")` inside a method body — a
      // syntax error at import, which takes the whole plugin (and its tool)
      // down at boot. The generator half of this plugin emits nothing here
      // because this package is not laid out as `<root>/packages/<name>/`; the
      // artifacts come from `pnpm gen:typert` instead.
      typertPlugin({ mode: 'package', faces: ['host'] }),
    ],
  },
  {
    // Browser bundle: lib/client.js, served by the harness at /plugins/<id>/client.js.
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    deps: {
      // Only the frozen platform module table stays external. `zod` must be
      // inlined: this package's own generated Remote contribution builds the
      // boundary decoder schemas with it, and the browser module table has no
      // `zod` — an external require there would fail the whole client plugin.
      neverBundle: [...PLATFORM_MODULES],
      alwaysBundle: ['zod'],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
