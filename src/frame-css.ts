/**
 * The stylesheet injected into every OpenUI frame: the DSH palette bridged
 * onto the `--openui-*` design tokens the component library reads, plus a
 * minimal page reset. Kept as a TS string so the browser bundle needs no CSS
 * loader and the node-side specs can assert against it.
 *
 * Token contract: every DSH colour arrives as a `--dsh-openui-<name>` custom
 * property that the card resolves from the live host theme and sets on the
 * frame's `:root`; outside DSH the `light-dark()` fallbacks keep the frame
 * legible in both appearances.
 *
 * The library ships 228 tokens whose light and dark halves differ only in
 * polarity, and whose `sunk`/`elevated` surfaces are the foreground at 4–8%
 * alpha. So rather than restate them, this sheet derives every derived token
 * with `color-mix()` from the few primitives DSH actually supplies — one rule
 * set that is correct in both appearances, and that wins over the library's own
 * `@media (prefers-color-scheme: dark)` block because an unqualified `:root`
 * block later in the cascade outranks an earlier media-query one.
 *
 * @module @blaueck/dsh-openui/frame-css
 */

/** The frame stylesheet, inlined into the sandboxed srcdoc document. */
export const FRAME_CSS = `
:root {
  /* Follows the OS, which is the same signal the library's own
     prefers-color-scheme media query switches on. Pinning this to one
     appearance would let the library pick its dark text palette while the
     fallbacks below stayed light — white text on a white card. The card
     overrides both with the host's resolved palette once it knows it. */
  color-scheme: light dark;
  accent-color: var(--openui-interactive-accent-default);
}

:root {
  /* The primitives DSH supplies, with standalone fallbacks. */
  --dsh-openui-bg: light-dark(rgb(247 247 248), rgb(23 23 24));
  --dsh-openui-bg-layer-1: light-dark(rgb(255 255 255), rgb(32 32 34));
  --dsh-openui-bg-layer-2: light-dark(rgb(250 250 251), rgb(39 39 42));
  --dsh-openui-bg-overlay: light-dark(rgb(255 255 255), rgb(41 41 44));
  --dsh-openui-fg: light-dark(rgb(24 24 27), rgb(244 244 245));
  --dsh-openui-fg-secondary: light-dark(rgb(82 82 91), rgb(161 161 170));
  --dsh-openui-border: light-dark(rgb(228 228 231), rgb(58 58 63));
  --dsh-openui-border-strong: light-dark(rgb(212 212 216), rgb(82 82 91));
  --dsh-openui-brand: light-dark(rgb(65 118 230), rgb(110 150 240));
  --dsh-openui-danger: light-dark(rgb(220 60 60), rgb(248 113 113));
  --dsh-openui-success: light-dark(rgb(22 152 90), rgb(74 222 128));
  --dsh-openui-warn: light-dark(rgb(217 138 22), rgb(250 204 21));

  /* Surfaces. */
  --openui-background: var(--dsh-openui-bg);
  --openui-foreground: var(--dsh-openui-bg-layer-1);
  --openui-popover-background: var(--dsh-openui-bg-overlay);
  --openui-inverted-background: var(--dsh-openui-fg);

  /* Sunk and elevated surfaces are the foreground at low alpha, so one
     derivation is correct on either background. */
  --openui-sunk-light: color-mix(in oklab, var(--dsh-openui-fg) 2%, transparent);
  --openui-sunk: color-mix(in oklab, var(--dsh-openui-fg) 4%, transparent);
  --openui-sunk-deep: color-mix(in oklab, var(--dsh-openui-fg) 8%, transparent);
  --openui-elevated-light: color-mix(in oklab, var(--dsh-openui-fg) 4%, transparent);
  --openui-elevated: color-mix(in oklab, var(--dsh-openui-fg) 8%, transparent);
  --openui-elevated-strong: color-mix(in oklab, var(--dsh-openui-fg) 16%, transparent);
  --openui-elevated-intense: color-mix(in oklab, var(--dsh-openui-fg) 32%, transparent);
  --openui-overlay: light-dark(rgb(0 0 0 / 40%), rgb(0 0 0 / 60%));
  --openui-highlight-subtle: color-mix(in oklab, var(--dsh-openui-fg) 2%, transparent);
  --openui-highlight: color-mix(in oklab, var(--dsh-openui-fg) 4%, transparent);
  --openui-highlight-strong: color-mix(in oklab, var(--dsh-openui-fg) 8%, transparent);
  --openui-highlight-intense: color-mix(in oklab, var(--dsh-openui-fg) 16%, transparent);

  /* Text ramp. */
  --openui-text-neutral-primary: var(--dsh-openui-fg);
  --openui-text-neutral-secondary: color-mix(in oklab, var(--dsh-openui-fg) 62%, transparent);
  --openui-text-neutral-tertiary: color-mix(in oklab, var(--dsh-openui-fg) 38%, transparent);
  --openui-text-neutral-link: var(--dsh-openui-brand);
  --openui-text-brand: var(--dsh-openui-brand);
  --openui-text-white: light-dark(rgb(255 255 255), rgb(9 9 11));
  --openui-text-black: light-dark(rgb(9 9 11), rgb(250 250 250));

  /* Semantic text. */
  --openui-text-info-primary: var(--dsh-openui-brand);
  --openui-text-success-primary: var(--dsh-openui-success);
  --openui-text-alert-primary: var(--dsh-openui-warn);
  --openui-text-danger-primary: var(--dsh-openui-danger);
  --openui-text-danger-secondary: color-mix(in oklab, var(--dsh-openui-danger) 70%, transparent);

  /* Semantic surfaces. */
  --openui-info-background: color-mix(in oklab, var(--dsh-openui-brand) 12%, transparent);
  --openui-success-background: color-mix(in oklab, var(--dsh-openui-success) 12%, transparent);
  --openui-alert-background: color-mix(in oklab, var(--dsh-openui-warn) 14%, transparent);
  --openui-danger-background: color-mix(in oklab, var(--dsh-openui-danger) 12%, transparent);
  --openui-purple-background: color-mix(in oklab, oklch(0.55 0.2 300) 12%, transparent);
  --openui-pink-background: color-mix(in oklab, oklch(0.62 0.2 350) 12%, transparent);

  /* Interaction. */
  --openui-interactive-accent-default: var(--dsh-openui-brand);
  --openui-interactive-accent-hover: color-mix(in oklab, var(--dsh-openui-brand) 85%, var(--dsh-openui-fg));
  --openui-interactive-accent-pressed: color-mix(in oklab, var(--dsh-openui-brand) 75%, black);
  --openui-interactive-accent-disabled: color-mix(in oklab, var(--dsh-openui-fg) 25%, transparent);
  --openui-interactive-destructive-default: var(--dsh-openui-danger);
  --openui-interactive-destructive-hover: color-mix(in oklab, var(--dsh-openui-danger) 85%, var(--dsh-openui-fg));
  --openui-interactive-destructive-pressed: color-mix(in oklab, var(--dsh-openui-danger) 75%, black);
  --openui-interactive-destructive-disabled: color-mix(in oklab, var(--dsh-openui-danger) 30%, transparent);

  /* Borders. */
  --openui-border-neutral-primary: var(--dsh-openui-border);
  --openui-border-neutral-secondary: var(--dsh-openui-border-strong);
}

/*
 * The reset the library assumes its host provides.
 *
 * openui-styles.css sets border-box on about seventy of its own rules and
 * leaves the rest at the initial content-box — including
 * .openui-overview-card, which combines width: 100% with horizontal padding.
 * Under content-box that card renders at 100% plus its padding, so it
 * overflows the grid track it was placed in by exactly that padding, and the
 * whole card then scrolls sideways. Every application stylesheet sets this rule;
 * a frame document has to set it too.
 */
*, *::before, *::after {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  color: var(--openui-text-neutral-primary);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial,
    "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* The frame paints the host's own base surface rather than leaving the viewport
   transparent: an opaque, matched background means a frame whose runtime has not
   arrived yet still reads as the conversation, never as a foreign dark canvas.
   Declared after the shared block above, whose transparent body would otherwise
   win on source order and hand the viewport back to the browser. */
html {
  background: var(--dsh-openui-bg);
}

body {
  background-color: transparent;
}

#openui-mount {
  display: block;
}

/* Card scaffolding the frame owns, outside the library's components. */
.openui-frame-notice {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--openui-danger-background);
  color: var(--openui-text-danger-primary);
}
.openui-frame-notice[data-tone="muted"] {
  background: var(--openui-sunk);
  color: var(--openui-text-neutral-secondary);
}
`
