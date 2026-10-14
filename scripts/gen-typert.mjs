#!/usr/bin/env node
/**
 * Generate this package's Typert face artifacts into `lib/`:
 *
 *   lib/typert.host.js            lib/typert.host.d.ts
 *   lib/typert.remote-client.js   lib/typert.remote-client.d.ts
 *   lib/typert.remote-client.d.ts.map
 *
 * `@deepseek-ai/dsh-typert-generator` only reflects over packages that
 * physically live under `<workspaceRoot>/packages/<name>/`, where
 * `<workspaceRoot>` is the nearest ancestor holding `tsconfig.host.json`
 * (`WorkspaceAnalyzer.loadRegistrations()` applies an `isWithin(root/packages)`
 * check to `realPath(packageRoot)`, so a symlink out of the workspace does not
 * work either). This repository is a plain single package with no `packages/`
 * directory, and that layout must not change.
 *
 * The generator is therefore pointed at a throwaway monorepo-shaped scratch
 * workspace under the OS temp dir:
 *
 *   <scratch>/tsconfig.host.json             aggregate: references + options
 *   <scratch>/packages/dsh-openui/           real copy of package.json + src/
 *   <scratch>/packages/dsh-typert-protocol/  real copy of the installed protocol
 *   <scratch>/node_modules -> <repo>/node_modules
 *
 * The protocol copy is not optional: `FaceAnalyzer.isTypeMetaSymbol()` only
 * accepts a `Remote` decorator whose declaration lives in a *registered*
 * workspace package named `@deepseek-ai/dsh-typert-protocol`, so the scratch
 * aggregate references that copy and its `paths` maps the bare specifier onto it.
 *
 * The emitted text is written straight into this package's `lib/`, so `src/`
 * stays the single source of truth and nothing generated is checked in.
 *
 * `WorkspaceTypertGenerator.validateExport()` also requires package.json's
 * `files` array to name each emitted artifact explicitly (`"lib"` alone is not
 * enough), which is why those four paths are listed there individually.
 *
 * Re-run `pnpm run gen:typert` whenever a `@Remote`/`@RemoteScope` method
 * signature in `src/host/` changes; the artifacts are a pure function of it.
 * `pnpm run build` already does so before tsdown (see package.json).
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Absolute path of the package being generated. */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
/** Package name the generator keys its models by. */
const packageName = '@blaueck/dsh-openui'
/** Directory name this package gets inside the scratch `packages/` tree. */
const packageDirName = 'dsh-openui'
/**
 * The generator only recognizes a `@Remote`/`@RemoteScope` decorator or a
 * `TypertRemoteService` heritage when the symbol's declaring file lives inside
 * a *registered* workspace package named `@deepseek-ai/dsh-typert-protocol`
 * (`FaceAnalyzer.isTypeMetaSymbol` → `registrationForFile`). In the real
 * monorepo that package is a sibling under `packages/`; the scratch workspace
 * therefore has to carry a copy of it and resolve the bare specifier to that
 * copy, or the host face models zero invocations and emits nothing.
 */
const protocolPackageName = '@deepseek-ai/dsh-typert-protocol'
/** Directory name the protocol package gets in the scratch `packages/` tree. */
const protocolDirName = 'dsh-typert-protocol'
/** Faces to emit; this package contributes a host face only. */
const faces = ['host']
/** Artifacts the host face alone must produce. */
const hostOutputs = ['typert.host.js', 'typert.host.d.ts']
/** Extra artifacts produced when the host face models Remote methods. */
const remoteOutputs = ['typert.remote-client.js', 'typert.remote-client.d.ts', 'typert.remote-client.d.ts.map']

/** Shared compiler options for both scratch configs (mirrors the repo tsconfig). */
const COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  module: 'esnext',
  moduleResolution: 'bundler',
  target: 'es2022',
  lib: ['es2022'],
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  skipLibCheck: true,
}

/**
 * Scratch aggregate config. `WorkspaceAnalyzer` reads `projectReferences` from
 * here to find contributing packages, and takes the *program* compiler options
 * from this file too (not from the referenced package config), so the options
 * mirror the repository's root tsconfig. The `paths` entry is what makes
 * `@deepseek-ai/dsh-typert-protocol` resolve to the scratch copy instead of the
 * installed dependency, which is what `isTypeMetaSymbol` checks.
 */
const AGGREGATE_TSCONFIG = {
  compilerOptions: {
    ...COMPILER_OPTIONS,
    baseUrl: '.',
    paths: { [protocolPackageName]: [`./packages/${protocolDirName}`] },
  },
  references: [{ path: `./packages/${packageDirName}` }, { path: `./packages/${protocolDirName}` }],
}

/**
 * Read the repository's host-face include/exclude so the scratch package config
 * is a true mirror of it: `WorkspaceAnalyzer` takes the program's root file
 * names from the referenced package's tsconfig, so a module that is not listed
 * there (or imported by one that is) is invisible to the generator.
 * @returns the include and exclude lists from `tsconfig.host.json`.
 */
function hostSourceGlobs() {
  const configPath = join(projectRoot, 'tsconfig.host.json')
  let config
  try {
    // The file is plain JSON in this repository (`extends` does not affect the
    // include list, which is what matters here).
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(config.include) || config.include.length === 0) {
    throw new Error(`${configPath} must declare a non-empty "include" list`)
  }
  return { include: config.include, exclude: Array.isArray(config.exclude) ? config.exclude : [] }
}

/**
 * Scratch package config. Only its `fileNames` are used (the aggregate supplies
 * the program options), but it must list every host entry point — including
 * `src/protocol.ts`, the public subpath module boundary types are exported from.
 */
const PACKAGE_TSCONFIG = {
  compilerOptions: COMPILER_OPTIONS,
  ...hostSourceGlobs(),
}

/**
 * Scratch config for the copied protocol package. It is never selected for
 * analysis (the emitter only ever sees this package), it only has to exist so
 * the project reference is valid and so `registrationForFile` can name it.
 */
const PROTOCOL_TSCONFIG = {
  compilerOptions: COMPILER_OPTIONS,
  include: ['lib/types'],
}

/**
 * Load the generator through this package's own dependency graph.
 * @returns the `WorkspaceTypertGenerator` class.
 */
async function loadGenerator() {
  try {
    const module = await import('@deepseek-ai/dsh-typert-generator')
    return module.WorkspaceTypertGenerator
  } catch (error) {
    throw new Error(
      `cannot load @deepseek-ai/dsh-typert-generator (run \`pnpm install\` first): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * Build the scratch workspace described in the module docblock.
 * @returns absolute path of the scratch root.
 */
function createScratchWorkspace() {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-openui-typert-'))
  const packageRoot = join(scratch, 'packages', packageDirName)
  const protocolRoot = join(scratch, 'packages', protocolDirName)
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(scratch, 'tsconfig.host.json'), `${JSON.stringify(AGGREGATE_TSCONFIG, null, 2)}\n`)
  writeFileSync(join(packageRoot, 'tsconfig.json'), `${JSON.stringify(PACKAGE_TSCONFIG, null, 2)}\n`)
  // A real copy, never a symlink: the generator applies realPath() and rejects
  // packages that resolve outside <scratch>/packages/.
  cpSync(join(projectRoot, 'package.json'), join(packageRoot, 'package.json'))
  cpSync(join(projectRoot, 'src'), join(packageRoot, 'src'), { recursive: true })
  // Registered copy of the Typert protocol package (see protocolPackageName).
  cpSync(dirname(require.resolve(`${protocolPackageName}/package.json`)), protocolRoot, { recursive: true })
  writeFileSync(join(protocolRoot, 'tsconfig.json'), `${JSON.stringify(PROTOCOL_TSCONFIG, null, 2)}\n`)
  // Bare-specifier resolution (@deepseek-ai/*, typescript) walks up from the
  // copied sources; point it at the installed dependency tree.
  symlinkSync(join(projectRoot, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  return scratch
}

/**
 * Fail unless one emitted artifact carries the runtime entry point the package's
 * exports promise, so a silently empty emission cannot ship.
 * @param file - artifact file name, for the error message.
 * @param text - emitted artifact text.
 * @param identifier - identifier the artifact must define.
 */
function requireIdentifier(file, text, identifier) {
  if (!new RegExp(`\\b${identifier}\\b`).test(text)) {
    throw new Error(`generated ${file} does not define ${identifier}; the Remote surface was not modeled`)
  }
}

/**
 * Run the generator against the scratch workspace and copy its text output into
 * `lib/`.
 * @param WorkspaceTypertGenerator - generator class loaded from the dependency.
 * @param scratch - absolute path of the scratch workspace root.
 * @returns the emitted host artifact and the `[name, bytes]` pairs written.
 */
async function generate(WorkspaceTypertGenerator, scratch) {
  const generator = new WorkspaceTypertGenerator(scratch, { checkDiagnostics: false })
  const discovered = generator.discover(faces)
  if (!discovered.some(candidate => candidate.package === packageName)) {
    throw new Error(
      `${packageName} was not discovered as a Typert host contributor; ` +
        `discovered: ${discovered.map(candidate => candidate.package).join(', ') || '(none)'}`,
    )
  }
  const host = generator
    .generate([packageName], faces)
    .find(artifact => artifact.face === 'host' && artifact.package === packageName)
  if (host === undefined) throw new Error(`the generator produced no host artifact for ${packageName}`)
  requireIdentifier('typert.host.js', host.js, 'TYPERT')

  const libDir = join(projectRoot, 'lib')
  mkdirSync(libDir, { recursive: true })
  /** @type {Array<[string, number]>} */
  const written = []
  const write = (name, text) => {
    writeFileSync(join(libDir, name), text)
    written.push([name, Buffer.byteLength(text)])
  }
  write('typert.host.js', host.js)
  write('typert.host.d.ts', host.dts)
  if (host.remote === undefined) {
    // No Remote methods: stale ./remote artifacts must not linger, or
    // validateExport() would reject the package on the next run.
    for (const name of remoteOutputs) rmSync(join(libDir, name), { force: true })
  } else {
    requireIdentifier('typert.remote-client.js', host.remote.js, 'TYPERT_REMOTE')
    // The two methods the host service actually declares. A rename in
    // src/host/remote.ts without updating this check must fail the build, since
    // the browser half calls these by name.
    requireIdentifier('typert.remote-client.d.ts', host.remote.dts, 'call')
    requireIdentifier('typert.remote-client.d.ts', host.remote.dts, 'catalog')
    write('typert.remote-client.js', host.remote.js)
    write('typert.remote-client.d.ts', host.remote.dts)
    write('typert.remote-client.d.ts.map', host.remote.dtsMap)
  }
  for (const name of [...hostOutputs, ...(host.remote === undefined ? [] : remoteOutputs)]) {
    if (!existsSync(join(libDir, name))) throw new Error(`expected artifact ${name} was not written`)
  }
  return { host, written }
}

/** Scratch workspace path, kept alive for inspection when generation fails. */
let scratchDir

try {
  const WorkspaceTypertGenerator = await loadGenerator()
  scratchDir = createScratchWorkspace()
  const { host, written } = await generate(WorkspaceTypertGenerator, scratchDir)
  rmSync(scratchDir, { recursive: true, force: true })
  const remote = host.remote === undefined ? 'absent' : 'present'
  console.log(`gen:typert — emitted the ${packageName} host face into lib/ (Remote surface: ${remote})`)
  for (const [name, bytes] of written) console.log(`  lib/${name}  ${bytes.toLocaleString('en-US')} bytes`)
} catch (error) {
  process.exitCode = 1
  console.error(`gen:typert failed — ${error instanceof Error ? error.message : String(error)}`)
  if (scratchDir !== undefined) console.error(`  scratch workspace kept at ${scratchDir}`)
}
