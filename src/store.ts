/**
 * Where registered components live on disk — the DSH profile directory.
 *
 * A registration is meant to outlive the session that made it, so it cannot go
 * in the workspace (a project may be checked out anywhere) or in the OS temp
 * directory (the card copies there are disposable). It goes beside the profile
 * that loads the plugin: `<DSH_PROFILE_DIR>/openui/components/*.json`, with the
 * generated incremental skill at `<DSH_PROFILE_DIR>/openui/openui-components.md`.
 * A new session loads the same profile, so it sees the same registry with no
 * extra wiring.
 *
 * Writes here deliberately do not go through `ctx.fs`: the file sandbox confines
 * *model-driven* file tools to the session workspace, and this registry is the
 * plugin's own configuration, reached only through the registration tool. Every
 * write is still an explicit, logged tool call.
 *
 * @module @blaueck/dsh-openui/store
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  COMPONENT_FILE_VERSION,
  MAX_COMPONENTS,
  componentFromFile,
  renderComponentsSkill,
  type ComponentProblem,
  type CustomComponent,
  type CustomComponentFile,
} from './registry.ts'

/** Registry contents plus the files that could not be read. */
export interface RegistrySnapshot {
  /** Readable components, sorted by name. */
  readonly components: CustomComponent[]
  /** Per-file findings; a broken file is skipped, never fatal. */
  readonly problems: ComponentProblem[]
}

/** Store options. */
export interface ComponentStoreOptions {
  /** Components directory, absolute. */
  readonly directory: string
  /** Generated incremental skill path; defaults beside the directory. */
  readonly skillPath?: string
  /** Maximum number of components this registry may hold. */
  readonly maxComponents?: number
}

/**
 * Resolve the profile's registry directory.
 *
 * `DSH_PROFILE_DIR` is the direct answer when the launcher exports it, but the
 * host process does not always have it — the desktop app injects it into shell
 * subprocesses, not into its own `process.env`. The HMR service's `baseDir` is
 * the profile root the Loader is watching, which is the next best fact; without
 * either, fall back to the home layout.
 * @param env - process environment, injectable for tests.
 * @param profileDir - the live profile root, when a service exposes it.
 * @returns the absolute components directory.
 */
export function defaultComponentsDirectory(env: NodeJS.ProcessEnv = process.env, profileDir?: string): string {
  const fromEnv = env['DSH_PROFILE_DIR']
  if (fromEnv !== undefined && fromEnv.length > 0) return join(fromEnv, 'openui', 'components')
  if (profileDir !== undefined && profileDir.length > 0) return join(profileDir, 'openui', 'components')
  const home = env['DSH_HOME'] !== undefined && env['DSH_HOME'].length > 0 ? env['DSH_HOME'] : join(homedir(), '.dsh')
  return join(home, 'profiles', env['DSH_PROFILE'] ?? 'default', 'openui', 'components')
}

/**
 * Resolve the configured directory, treating a relative path as profile-relative.
 * @param configured - the `componentsDir` config value; empty means the default.
 * @param env - process environment, injectable for tests.
 * @returns the absolute directory.
 */
export function resolveComponentsDirectory(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
  profileDir?: string,
): string {
  const value = configured.trim()
  if (value.length === 0) return defaultComponentsDirectory(env, profileDir)
  if (isAbsolute(value)) return value
  const base = env['DSH_PROFILE_DIR']
    ?? profileDir
    ?? join(env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'profiles', env['DSH_PROFILE'] ?? 'default')
  return resolve(base, value)
}

/**
 * Reduce a component name to a stable file name.
 * @param name - the PascalCase component name.
 * @returns a lowercase slug; the manifest inside keeps the real name.
 */
export function fileSlug(name: string): string {
  return name.replaceAll(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-')
}

/** One profile's component registry, backed by JSON files. */
export class ComponentStore {
  /** Directory holding one JSON file per component. */
  readonly directory: string
  /** Generated incremental skill file. */
  readonly skillPath: string
  /** Registry size ceiling enforced by the registration tool. */
  readonly maxComponents: number

  /**
   * @param options - directory, optional skill path and ceiling.
   */
  constructor(options: ComponentStoreOptions) {
    this.directory = options.directory
    this.skillPath = options.skillPath ?? join(dirname(options.directory), 'openui-components.md')
    this.maxComponents = options.maxComponents ?? MAX_COMPONENTS
  }

  /**
   * Read every component file in the registry.
   *
   * The directory is re-read on every call: a profile is small, and a session
   * that starts after another session registered a component must see it without
   * a restart. Unreadable or malformed files are reported and skipped, so one
   * hand-edited file cannot take down the catalog.
   * @returns the readable components and the per-file findings.
   */
  async load(): Promise<RegistrySnapshot> {
    const problems: ComponentProblem[] = []
    let entries
    try {
      entries = await readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return { components: [], problems }
      throw error
    }

    const components: CustomComponent[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(this.directory, entry.name)
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        const component = componentFromFile(parsed)
        if (component === undefined) {
          problems.push({
            code: 'bad-file',
            message: `\`${entry.name}\` is not a usable component manifest; it was skipped.`,
          })
          continue
        }
        components.push(component)
      } catch (error) {
        problems.push({
          code: 'unreadable-file',
          message: `\`${entry.name}\` could not be read (${error instanceof Error ? error.message : String(error)}); it was skipped.`,
        })
      }
    }
    components.sort((left, right) => left.name.localeCompare(right.name))
    return { components, problems }
  }

  /**
   * Write one component, preserving its original creation time.
   * @param component - the validated component.
   * @returns the absolute path written.
   */
  async save(component: CustomComponent): Promise<string> {
    await mkdir(this.directory, { recursive: true })
    const previous = await this.find(component.name)
    const now = new Date().toISOString()
    const file: CustomComponentFile = {
      version: COMPONENT_FILE_VERSION,
      ...component,
      createdAt: previous?.createdAt ?? component.createdAt ?? now,
      updatedAt: now,
    }
    const path = this.fileOf(component.name)
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
    await this.writeSkill()
    return path
  }

  /**
   * Delete one registered component.
   * @param name - the component name.
   * @returns whether a file was removed.
   */
  async remove(name: string): Promise<boolean> {
    const existing = await this.find(name)
    if (existing === undefined) return false
    await rm(this.fileOf(name), { force: true })
    await this.writeSkill()
    return true
  }

  /**
   * Load the registry and regenerate the incremental skill file from it.
   * @returns the rendered skill text and the snapshot it was rendered from.
   */
  async writeSkill(): Promise<{ skill: string; snapshot: RegistrySnapshot }> {
    const snapshot = await this.load()
    const skill = renderComponentsSkill(snapshot.components)
    await mkdir(dirname(this.skillPath), { recursive: true })
    await writeFile(this.skillPath, `${skill}\n`, 'utf8')
    return { skill, snapshot }
  }

  /**
   * Read the incremental skill, regenerating the file if it is absent.
   * The rendered text is always the source of truth; the file is a mirror for
   * inspection and for a human editing the profile by hand.
   * @returns the skill body.
   */
  async skill(): Promise<string> {
    const snapshot = await this.load()
    const skill = renderComponentsSkill(snapshot.components)
    try {
      const existing = await readFile(this.skillPath, 'utf8')
      if (existing.trim() === skill.trim()) return existing
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await mkdir(dirname(this.skillPath), { recursive: true })
    await writeFile(this.skillPath, `${skill}\n`, 'utf8')
    return skill
  }

  /**
   * Absolute path of one component's file.
   * @param name - the component name.
   * @returns the path the component is (or would be) stored at.
   */
  fileOf(name: string): string {
    return join(this.directory, `${fileSlug(name)}.json`)
  }

  /**
   * Find a readable component by name.
   * @param name - the component name.
   * @returns the component, or undefined when no file carries it.
   */
  private async find(name: string): Promise<CustomComponent | undefined> {
    const snapshot = await this.load()
    return snapshot.components.find(component => component.name === name)
  }
}

/**
 * Whether a filesystem failure means "the path does not exist".
 * @param error - the thrown value.
 * @returns true for ENOENT.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
