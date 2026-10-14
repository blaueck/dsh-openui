/**
 * Read the live DSH palette out of the host document and translate it into the
 * `--dsh-openui-*` properties the frame stylesheet consumes.
 *
 * The DSH tokens are read as computed values rather than assumed, so the card
 * follows whatever theme the host settled on — including a manual choice that
 * disagrees with the OS — and the appearance is derived from the resolved
 * background colour instead of trusting a class name.
 *
 * @module @blaueck/dsh-openui/client/theme
 */

/** DSH design token → the frame bridge property that reads it. */
const TOKEN_MAP: ReadonlyArray<readonly [dsh: string, bridge: string]> = [
  ['--dsw-alias-bg-base', '--dsh-openui-bg'],
  ['--dsw-alias-bg-layer-1', '--dsh-openui-bg-layer-1'],
  ['--dsw-alias-bg-layer-2', '--dsh-openui-bg-layer-2'],
  ['--dsw-alias-bg-overlay', '--dsh-openui-bg-overlay'],
  ['--dsw-alias-label-primary', '--dsh-openui-fg'],
  ['--dsw-alias-label-secondary', '--dsh-openui-fg-secondary'],
  ['--dsw-alias-border-l1', '--dsh-openui-border'],
  ['--dsw-alias-border-l2', '--dsh-openui-border-strong'],
  ['--dsw-alias-brand-primary', '--dsh-openui-brand'],
  ['--dsw-alias-state-error-primary', '--dsh-openui-danger'],
  ['--dsw-alias-state-success-primary', '--dsh-openui-success'],
  ['--dsw-alias-state-warn-primary', '--dsh-openui-warn'],
]

/** The host palette, already translated for the frame. */
export interface ResolvedTheme {
  /** Frame bridge properties to set on the frame's `:root`. */
  vars: Record<string, string>
  /** Appearance the host is currently in. */
  scheme: 'light' | 'dark'
}

/**
 * Resolve the host palette for one frame.
 * @param doc - the host document; defaults to the ambient one.
 * @returns the bridge properties and the appearance.
 */
export function resolveTheme(doc: Document = document): ResolvedTheme {
  const computed = getComputedStyle(doc.documentElement)
  const vars: Record<string, string> = {}
  for (const [dsh, bridge] of TOKEN_MAP) {
    const value = computed.getPropertyValue(dsh).trim()
    if (value.length > 0) vars[bridge] = value
  }
  return { vars, scheme: resolveScheme(doc) }
}

/**
 * Decide the host appearance from the resolved base background rather than a
 * class name, so it is right however the theme was applied.
 * @param doc - the host document.
 * @returns `dark` when the base surface is darker than mid grey.
 */
function resolveScheme(doc: Document): 'light' | 'dark' {
  const probe = doc.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;width:1px;height:1px;'
    + 'background-color:var(--dsw-alias-bg-base, #fff)'
  doc.body.appendChild(probe)
  let background: string
  try {
    background = getComputedStyle(probe).backgroundColor
  } finally {
    probe.remove()
  }
  const rgb = parseRgb(background)
  if (rgb === undefined) return 'light'
  // Rec. 601 luma is enough to separate a light surface from a dark one.
  const luma = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255
  return luma < 0.5 ? 'dark' : 'light'
}

/**
 * Parse a resolved `rgb()` / `rgba()` colour.
 * @param value - the computed colour.
 * @returns the three channels, or undefined when it is not an rgb colour.
 */
function parseRgb(value: string): [number, number, number] | undefined {
  const match = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/u.exec(value)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Watch for host theme changes.
 *
 * The host flips themes by rewriting custom properties on the root element, so
 * a class/style observer plus the OS preference listener covers both the manual
 * and the system-driven case.
 * @param doc - the host document.
 * @param listener - called when the palette may have changed.
 * @returns a disposer removing every subscription.
 */
export function observeTheme(doc: Document, listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  if (doc.body !== null) {
    observer.observe(doc.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  }
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
  media?.addEventListener('change', listener)
  return () => {
    observer.disconnect()
    media?.removeEventListener('change', listener)
  }
}
