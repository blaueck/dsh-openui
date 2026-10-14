/**
 * The sandboxed frame document and the parent/frame message protocol.
 *
 * The card is an `<iframe sandbox="allow-scripts">` with an opaque origin: the
 * OpenUI program is data, but the frame still owns the origin boundary. The
 * frame can reach nothing but `postMessage`.
 *
 * ## Why the official browser bundle, and not the CDN module graph
 *
 * The obvious way to load OpenUI in a frame is to import `react`,
 * `react-dom/client`, `@openuidev/react-lang` and `@openuidev/react-ui` from
 * jsDelivr's `+esm` builds. That does not work, and the failure is silent: the
 * `+esm` build of `react-dom/client` rewrites its React peer — declared as the
 * range `^19.3.0` — to the literal URL `/npm/react@%5E19.3.0/+esm`, while
 * `react-lang` imports `/npm/react@19.3.0/+esm`. Same code, two URLs, so the
 * browser instantiates React twice and the renderer's hooks throw
 * `Cannot read properties of null (reading 'useInsertionEffect')`. The card then
 * paints nothing at all.
 *
 * `@openuidev/browser-bundle` exists for exactly this case — the OpenUI authors
 * ship a single IIFE containing React, React-DOM, the renderer and the component
 * library — so the frame loads one script and one stylesheet and there is no
 * module resolution left to get wrong.
 *
 * The bundle exports `window.__OpenUI = { React, createRoot, Renderer,
 * openuiChatLibrary }`. It ships the **chat** library (root `Card`), which is the
 * one this plugin validates against; see `scripts/gen-library.mjs`.
 *
 * Kept free of DOM access so the node-side specs can assert against the built
 * document.
 *
 * @module @blaueck/dsh-openui/shell
 */

/** Pinned bundle and stylesheet the frame loads. */
export const OPENUI_RUNTIME = {
  bundle: 'https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@0.2.0/dist/openui-bundle.min.js',
  styles: 'https://cdn.jsdelivr.net/npm/@openuidev/browser-bundle@0.2.0/dist/openui-styles.css',
} as const

/** Global the bundle installs the runtime on. */
export const OPENUI_GLOBAL = '__OpenUI'

/** Id of the element the frame mounts the OpenUI surface into. */
export const OPENUI_FRAME_MOUNT_ID = 'openui-mount'

/** Field carrying the per-card token every frame message must echo. */
export const FRAME_TOKEN_FIELD = '__dshOpenUI'

/** Frame → parent message types. */
export const FRAME_BOOT = 'boot'
export const FRAME_READY = 'ready'
export const FRAME_HEIGHT = 'height'
export const FRAME_ACTION = 'action'
export const FRAME_ERROR = 'error'
/** Frame → parent: one card-initiated tool call the parent must answer. */
export const FRAME_TOOLCALL = 'toolcall'

/** Parent → frame message types. */
export const FRAME_SET = 'set'
export const FRAME_THEME = 'theme'
/** Parent → frame: the answer to one {@link FRAME_TOOLCALL}. */
export const FRAME_TOOLRESULT = 'toolresult'

/**
 * Content-Security-Policy for the frame document.
 *
 * `'unsafe-eval'` is load-bearing and deliberate: the component library reaches
 * the frame through `react-syntax-highlighter`, whose `refractor` dependency
 * evaluates code at module-init time, so a policy without the allowance throws
 * an `EvalError` and the card never paints. It costs little here — the frame
 * already runs at an opaque origin with `default-src 'none'`, cannot post a
 * form, cannot nest a frame, and can reach exactly one network origin, so the
 * worst an eval can do is misbehave inside a sandbox that holds no session and
 * no credentials.
 */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net",
  'font-src https://cdn.jsdelivr.net data:',
  'img-src https: data: blob:',
  "connect-src https://cdn.jsdelivr.net blob: data:",
  'worker-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** Host palette overrides the card resolved from the live DSH theme. */
export type FrameThemeVars = Readonly<Record<string, string>>

/** What the card sends the frame to paint one state of the program. */
export interface FrameSetMessage {
  /** The program text, whole or still streaming. */
  source: string
  /** Whether the model is still writing it (disables form interaction). */
  streaming: boolean
  /**
   * Tool names the program passes to `Query()`, resolved by the host when it
   * parsed the program. This is the authoritative read/write split; the frame
   * cannot derive it reliably on its own (see the FRAME_TOOLCALL handling).
   */
  readTools?: readonly string[]
  /** Tool names the program passes to `Mutation()`, resolved the same way. */
  writeTools?: readonly string[]
  /** Host palette overrides; omitted leaves the previous ones in place. */
  theme?: FrameThemeVars
  /** Appearance to declare to the frame, so native controls match. */
  scheme?: 'light' | 'dark'
}

/**
 * Serialize a value for embedding inside a frame `<script>`. Escaping every
 * `<` keeps program text that contains `</script>` from closing the block.
 * @param value - the JSON-serializable value.
 * @returns the escaped JSON text.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/**
 * Build the frame-side boot script.
 *
 * A classic script, not a module: the bundle installs its global synchronously,
 * so there is nothing to await and no module graph left to resolve. The script
 * never uses a template literal of its own, so this builder can interpolate
 * safely.
 * @param options - runtime table, mount id, card token, global name and stylesheet.
 * @returns the inline `<script>` body.
 */
function frameScript(options: {
  runtime: typeof OPENUI_RUNTIME
  mountId: string
  token: string
  tokenField: string
  global: string
  css: string
}): string {
  return `<script>
(function () {
  var RUNTIME = ${jsonForScript(options.runtime)};
  var MOUNT_ID = ${JSON.stringify(options.mountId)};
  var TOKEN_FIELD = ${JSON.stringify(options.tokenField)};
  var TOKEN = ${jsonForScript(options.token)};
  var GLOBAL_NAME = ${JSON.stringify(options.global)};
  var CSS = ${jsonForScript(options.css)};

  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  var mount = document.getElementById(MOUNT_ID);

  /** Post one message to the parent, tagged with this frame's card token. */
  function send(type, payload) {
    var message = Object.assign({ [TOKEN_FIELD]: TOKEN, type: type }, payload || {});
    try { parent.postMessage(message, '*'); } catch (error) { /* parent gone */ }
  }

  /** Render one of the frame's own notices in place of the surface. */
  function notice(text) {
    if (!mount) return;
    mount.textContent = '';
    var p = document.createElement('p');
    p.className = 'openui-frame-notice';
    p.textContent = text;
    mount.appendChild(p);
    reportHeight();
  }

  var lastHeight = -1;
  /** Tell the parent how tall the card currently is, so it can size the frame. */
  function reportHeight() {
    var height = Math.ceil(Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    ));
    if (height !== lastHeight) {
      lastHeight = height;
      send('height', { height: height });
    }
  }

  /**
   * Narrow the library's action event to plain JSON. The event is the only path
   * out of the frame that a program author controls, so only these fields cross.
   */
  function normalizeAction(event) {
    if (!event || typeof event !== 'object') return { type: 'unknown', params: {} };
    return {
      type: typeof event.type === 'string' ? event.type : 'unknown',
      params: event.params && typeof event.params === 'object' ? event.params : {},
      humanFriendlyMessage: typeof event.humanFriendlyMessage === 'string' ? event.humanFriendlyMessage : '',
      formState: event.formState && typeof event.formState === 'object' ? event.formState : null,
      formName: typeof event.formName === 'string' ? event.formName : null
    };
  }

  /** Summarize parser errors for the frame notice and the parent log. */
  function formatErrors(errors) {
    if (!errors || !errors.length) return 'the program could not be parsed';
    return errors.slice(0, 4).map(function (error) {
      var where = error && error.statementId ? ' (' + error.statementId + ')' : '';
      var code = error && error.code ? error.code : 'parse';
      var message = error && error.message ? error.message : String(error);
      return code + where + ': ' + message;
    }).join('\\n');
  }

  /** Apply the host palette the card resolved from the live DSH theme. */
  function applyTheme(message) {
    var vars = message.theme;
    if (vars && typeof vars === 'object') {
      var root = document.documentElement;
      for (var name in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, name)) root.style.setProperty(name, vars[name]);
      }
    }
    if (message.scheme === 'light' || message.scheme === 'dark') {
      document.documentElement.style.colorScheme = message.scheme;
    }
  }

  // ---- Card-initiated tool calls ------------------------------------------
  //
  // A program's Query()/Mutation() asks for data through the toolProvider the
  // renderer was given. The frame cannot reach the host, so every call becomes a
  // request the parent answers: a correlation id goes out, the matching reply
  // comes back, and the promise settles. An unanswered request is rejected on a
  // timer rather than left pending, so a stalled card cannot wedge its queries.

  var TOOL_TIMEOUT_MS = 25000;
  var callSeq = 0;
  var pendingCalls = {};
  // Tool names this program declared as a Query and as a Mutation. The
  // renderer's toolProvider carries no statement identity, so these two sets are
  // how one call is attributed to the allowlist its statement kind belongs to.
  // A name that is not a literal, or appears nowhere, goes to the stricter side.
  var queryTools = {};
  var mutationTools = {};
  // The host parsed the program when it validated it, so it already knows which
  // tool names belong to Query() and which to Mutation(). Those arrive with the
  // program and are authoritative; the sets above are only a fallback for the
  // paths that have no host parse (a still-streaming call, a nested dispatch).
  var declaredRead = {};
  var declaredWrite = {};

  /** Turn one arriving name list into a lookup object. */
  function nameSet(names) {
    var set = {};
    if (Object.prototype.toString.call(names) === '[object Array]') {
      for (var i = 0; i < names.length; i++) {
        if (typeof names[i] === 'string') set[names[i]] = true;
      }
    }
    return set;
  }

  /** Read a literal tool name out of a Query/Mutation first argument. */
  function literalToolName(node) {
    return node && node.k === 'Str' && typeof node.v === 'string' ? node.v : undefined;
  }

  /** Record which tool names this program uses for reads and for writes. */
  function trackProgramTools(result) {
    if (!result || typeof result !== 'object') return;
    var queries = {};
    var mutations = {};
    (result.queryStatements || []).forEach(function (statement) {
      var name = literalToolName(statement && statement.toolAST);
      if (name !== undefined) queries[name] = true;
    });
    (result.mutationStatements || []).forEach(function (statement) {
      var name = literalToolName(statement && statement.toolAST);
      if (name !== undefined) mutations[name] = true;
    });
    queryTools = queries;
    mutationTools = mutations;
  }

  /**
   * Attribute one call to the allowlist its statement kind belongs to.
   *
   * The host's lists win when they are present. They are absent only for a card
   * that has no host parse to draw on, and there the frame's own parse callback
   * decides. A name in neither is treated as a write, which is the stricter
   * allowlist — an unattributable call must not slip through as a harmless read.
   */
  function callKind(toolName) {
    if (declaredWrite[toolName] === true) return 'mutation';
    if (declaredRead[toolName] === true) return 'query';
    if (mutationTools[toolName] === true) return 'mutation';
    if (queryTools[toolName] === true) return 'query';
    return 'mutation';
  }

  /** Ask the parent to run one tool; resolves with the value the card renders. */
  function callTool(toolName, args) {
    return new Promise(function (resolve, reject) {
      var id = 'c' + (++callSeq);
      var timer = setTimeout(function () {
        if (pendingCalls[id] === undefined) return;
        delete pendingCalls[id];
        reject(new Error('the host did not answer the ' + toolName + ' call in time'));
      }, TOOL_TIMEOUT_MS);
      pendingCalls[id] = { resolve: resolve, reject: reject, timer: timer };
      send('toolcall', { id: id, tool: toolName, args: args, kind: callKind(toolName) });
    });
  }

  /** Settle one outstanding call from the parent's reply. */
  function settleCall(message) {
    var entry = pendingCalls[message.id];
    if (entry === undefined) return;
    delete pendingCalls[message.id];
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message.value);
    else entry.reject(new Error(typeof message.error === 'string' ? message.error : 'the tool call failed'));
  }

  var api = null;
  var root = null;
  var current = { source: '', streaming: false };
  var painted = false;

  /** Paint the current program state through the OpenUI renderer. */
  function render() {
    if (!api || !root) return;
    root.render(api.React.createElement(api.Renderer, {
      response: current.source,
      library: api.openuiChatLibrary,
      isStreaming: current.streaming,
      // Queries and mutations reach the host through this provider. The
      // renderer accepts two shapes and tells them apart by probing for a
      // callTool member: an object carrying one is used as an MCP-like client
      // and called as callTool({ name, arguments }), while anything else is read
      // as a plain map of tool name to function. A card's tool names are not
      // known in advance — they come from the program and are gated on the host
      // — so this must be the MCP-like shape, and its reply must be MCP-shaped
      // too, because the renderer unwraps it before the program sees the value.
      toolProvider: {
        callTool: function (params) {
          var name = params && typeof params.name === 'string' ? params.name : undefined;
          var args = params ? params.arguments : undefined;
          return callTool(name, args).then(function (value) {
            // Carry the value on both branches the unwrapper knows — the
            // structured field it prefers and the text field it falls back to
            // parsing — so either resolution yields the same data.
            return {
              structuredContent: value,
              content: value === undefined ? [] : [{ type: 'text', text: JSON.stringify(value) }]
            };
          });
        }
      },
      onParseResult: trackProgramTools,
      onAction: function (event) { send('action', { event: normalizeAction(event) }); },
      onError: function (errors) {
        // The renderer reports an empty list on the first paint, before any
        // source has arrived. Relaying that would put a bogus parse failure
        // under a card that renders perfectly.
        if (!errors || !errors.length) return;
        var text = formatErrors(errors);
        send('error', { message: text });
        if (!painted) notice('OpenUI could not parse this program: ' + text);
      }
    }));
    painted = true;
    requestAnimationFrame(reportHeight);
  }

  window.addEventListener('message', function (messageEvent) {
    var data = messageEvent.data;
    if (!data || data[TOKEN_FIELD] !== TOKEN) return;
    if (data.type === 'theme') { applyTheme(data); return; }
    if (data.type === 'toolresult') { settleCall(data); return; }
    if (data.type !== 'set') return;
    applyTheme(data);
    declaredRead = nameSet(data.readTools);
    declaredWrite = nameSet(data.writeTools);
    current = { source: typeof data.source === 'string' ? data.source : '', streaming: !!data.streaming };
    render();
  });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  } else {
    setInterval(reportHeight, 500);
  }
  window.addEventListener('load', reportHeight);

  // Reported before the runtime is consulted, so the parent can tell "the frame
  // script never ran" (a CSP failure) apart from "the bundle never arrived".
  send('boot', {});

  try {
    api = window[GLOBAL_NAME];
    if (!api) throw new Error('the bundle did not install window.' + GLOBAL_NAME);
    if (api.Renderer === undefined) throw new Error('the renderer export is missing');
    if (!api.openuiChatLibrary) throw new Error('the component library export is missing');
    if (typeof api.createRoot !== 'function') throw new Error('createRoot is missing');
    root = api.createRoot(mount);
    render();
    send('ready', {});
    reportHeight();
  } catch (error) {
    var detail = error && error.message ? error.message : String(error);
    notice('OpenUI runtime failed to load: ' + detail);
    send('error', { message: 'OpenUI runtime failed to load: ' + detail });
  }
})();
</script>`
}

/**
 * Build the whole `srcdoc` document for one card frame.
 * @param options - the per-card token and the frame stylesheet.
 * @returns the document text.
 */
export function buildFrameDoc(options: {
  token: string
  css: string
  runtime?: typeof OPENUI_RUNTIME
}): string {
  const runtime = options.runtime ?? OPENUI_RUNTIME
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<link rel="stylesheet" href="${runtime.styles}">
</head>
<body>
<div id="${OPENUI_FRAME_MOUNT_ID}"></div>
<script src="${runtime.bundle}"></script>
${frameScript({
    runtime,
    mountId: OPENUI_FRAME_MOUNT_ID,
    token: options.token,
    tokenField: FRAME_TOKEN_FIELD,
    global: OPENUI_GLOBAL,
    css: options.css,
  })}
</body>
</html>`
}
