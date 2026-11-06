/**
 * Client half of the Embedded Browser plugin.
 *
 * Responsibilities:
 * - Register a "browser" tab type on the right Sidebar.
 * - Render the tab chrome (address bar, back/forward/reload, tab strip) with
 *   host theme tokens only.
 * - Mount native webview guests through the undocumented dshDesktop.browser
 *   bridge; partitioning and security properties are runtime-dependent and
 *   have not been verified.
 * - Long-poll the Host command channel, execute commands inside the guest
 *   (navigate, click, type, scroll, snapshot, closeTab, clearData), and post
 *   results/events back.
 *
 * Page content and the guest document are untrusted. Page text and DOM values
 * are read into snapshots, and password/hidden-field handling is best-effort;
 * arbitrary page content may still reach the Agent.
 */

const PLUGIN_ID = "dsh-agentic-browser";
const API_PATH = "/dsh-agentic-browser/api";
// Mounted panel bodies ({ sessionId, node }) across all sessions of this
// window. With keepMounted, hidden panels stay registered here, which is how
// the auto-present poller tells "has a panel" apart from "is visible".
const panelRegistry = new Set();
// Set by SessionVisibilityMarker (a session-scoped slot component that mounts
// while its session is displayed): the id of the on-screen session, or null.
let visibleMarkerSessionId = null;
// The session currently on screen. The marker is authoritative for every
// session — including ones without a browser panel —; the panel-container
// probe remains only as a pre-marker fallback.
function currentVisibleSessionId() {
  if (visibleMarkerSessionId) return visibleMarkerSessionId;
  for (const entry of panelRegistry) {
    const container = entry.node?.closest?.("[data-sidebar-right-session]");
    if (!container) continue;
    if (!container.closest("[hidden]") && window.getComputedStyle(container).visibility !== "hidden") {
      return entry.sessionId;
    }
  }
  return null;
}

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    // Crash telemetry: any uncaught error/rejection in this module (including
    // render crashes that blank the sidebar pane) is beaconed to the Host log
    // so the debug tool can read what actually happened.
    const reportClientError = (kind, message) => {
      try {
        fetch(`${location.origin}${API_PATH}/client-error?m=${encodeURIComponent(`${kind}: ${String(message).slice(0, 180)}`)}`, { cache: "no-store" }).catch(() => {});
      } catch { /* never recursive */ }
    };
    window.addEventListener("error", (event) => reportClientError("error", event?.message || event?.error || "unknown"));
    window.addEventListener("unhandledrejection", (event) => reportClientError("rejection", event?.reason?.message || event?.reason || "unknown"));

    // Render error boundary: a crash in the panel must not blank the whole
    // sidebar pane — show the error text (and report it) instead.
    class PanelErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      componentDidCatch(error) { reportClientError("render", error?.message || error); }
      render() {
        if (this.state.error) {
          // keepMounted keeps this component alive across session switches,
          // so without a retry an error would lock the panel until restart.
          return h("div", { style: { padding: 12, fontSize: 12, color: "var(--dsw-alias-state-error-primary, #c00)", whiteSpace: "pre-wrap", wordBreak: "break-all" } },
            "Agent 浏览器面板渲染错误：", String(this.state.error?.message || this.state.error),
            h("button", {
              type: "button",
              style: { display: "block", marginTop: 8, padding: "4px 12px", fontSize: 12, cursor: "pointer" },
              onClick: () => this.setState({ error: null }),
            }, "重试"));
        }
        return this.props.children;
      }
    }

    /* ------------------------------------------------------------------
     * CSS (host theme tokens only)
     * ---------------------------------------------------------------- */
    let cssInjected = false;
    function ensureCss() {
      if (cssInjected || typeof document === "undefined") return;
      cssInjected = true;
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.textContent = `
.eb-root{height:100%;min-height:0;position:relative;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.eb-toolbar{flex:none;display:flex;align-items:center;gap:4px;height:38px;padding:5px 6px;box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.eb-tool{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;border-radius:4px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.eb-tool:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.eb-tool:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}
.eb-addressBox{flex:auto;min-width:0;display:flex}
.eb-address{box-sizing:border-box;width:100%;height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 9px;outline:none}
.eb-content{flex:auto;min-height:0;display:flex;flex-direction:column;position:relative}
.eb-tabstrip{flex:none;display:flex;gap:2px;padding:4px 6px 0;box-sizing:border-box;overflow-x:auto;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.eb-tab{display:flex;align-items:center;gap:6px;max-width:180px;padding:4px 6px;border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:4px 4px 0 0;cursor:pointer;font-size:12px;line-height:1;white-space:nowrap;overflow:hidden}
.eb-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.eb-tabTitle{overflow:hidden;text-overflow:ellipsis}
.eb-tabClose{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:inherit;border-radius:50%;cursor:pointer;font-size:11px;line-height:1;padding:0}
.eb-tabClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.eb-viewport{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-base)}
.eb-guest-mount{position:relative;flex:none;width:100%;height:100%}
.eb-guest-mount[hidden]{display:none}
.eb-webview{position:absolute;inset:0;width:100%;height:100%;border:0;display:flex}
.eb-guest-mount[data-mobile="true"]{box-shadow:0 0 0 .5px var(--dsh-alias-border-l2)}
.eb-width-handle{position:absolute;left:-6px;top:0;bottom:0;width:12px;cursor:ew-resize;z-index:6;touch-action:none}
.eb-width-handle::after{content:"";position:absolute;left:5px;top:50%;transform:translateY(-50%);width:3px;height:44px;border-radius:2px;background:var(--dsh-alias-border-l2)}
.eb-menu-backdrop{position:fixed;inset:0;z-index:20}
.eb-menu{position:absolute;right:6px;top:70px;z-index:21;min-width:190px;padding:4px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.18)}
.eb-menu-item{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;text-align:left;cursor:pointer;border-radius:4px}
.eb-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.eb-menu-item:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}
.eb-menu-check{width:14px;display:inline-flex;flex:none}
.eb-menu-sep{height:.5px;background:var(--dsw-alias-border-l3);margin:4px 6px}
.eb-resbar{flex:none;display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-label-secondary)}
.eb-resbar input{width:64px;height:24px;padding:0 6px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.eb-resbar button{height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:11px}
.eb-resbar button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.eb-resbar select{height:24px;padding:0 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px}
.eb-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;padding:0 24px}
.eb-warning{flex:none;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l3)}
.eb-loading{flex:none;height:2px;background:var(--dsw-alias-border-l3);overflow:hidden;position:relative}
.eb-loading>span{position:absolute;inset:0;width:40%;background:var(--dsw-alias-label-primary);animation:eb-slide 1s linear infinite}
@keyframes eb-slide{from{transform:translateX(-100%)}to{transform:translateX(350%)}}
`;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------
     * Address validation (mirror of Host allowlist; UX guard only)
     * ---------------------------------------------------------------- */
    const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
    const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

    // Mobile emulation: iPhone Safari UA applied to the guest at creation.
    const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    // Desktop guests must NOT inherit the Electron default UA, which embeds an
    // application identifier that sites use to flag automated traffic. Pin a
    // pristine Chrome-on-Windows UA instead.
    const DESKTOP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    const DEFAULT_DEVICE_MODE = { mobile: false, width: 390 };
    // Common virtual resolutions for the resolution bar (contain-scaled).
    const RESOLUTION_PRESETS = [
      { label: "1920×1080", w: 1920, h: 1080 },
      { label: "1366×768", w: 1366, h: 768 },
      { label: "1280×720", w: 1280, h: 720 },
      { label: "1080×1920", w: 1080, h: 1920 },
      { label: "750×1334", w: 750, h: 1334 },
    ];

    // Key definitions for the press command (keyCode/which legacy fields included
    // because many handlers still read them).
    const PRESS_KEY_DEFS = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13 },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      Space: { key: " ", code: "Space", keyCode: 32 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    };

    // Injected into every guest on dom-ready so the Agent can read recent page
    // errors and warnings (diagnosing blank pages, failed loads, SPA crashes).
    const CONSOLE_HOOK_SOURCE = `(function(){
      if (window.__ebConsole) return true;
      var ring = [];
      window.__ebConsole = ring;
      function push(kind, args) {
        try {
          var text = Array.prototype.map.call(args, function (a) {
            try { return String(a); } catch (e) { return "[unstringifiable]"; }
          }).join(" ").slice(0, 500);
          ring.push({ kind: kind, text: text, at: Date.now() });
          if (ring.length > 50) ring.shift();
        } catch (e) { /* never break the page */ }
      }
      ["error", "warn"].forEach(function (k) {
        var orig = console[k];
        console[k] = function () { push(k, arguments); return orig.apply(this, arguments); };
      });
      window.addEventListener("error", function (e) { push("error", [String(e.message) + " @" + String(e.filename || "") + ":" + String(e.lineno || "")]); });
      window.addEventListener("unhandledrejection", function (e) { push("error", ["Unhandled rejection: " + String(e.reason)]); });
      return true;
    })()`;
    // Mirror of the Host's sameLoopbackOrigin: two http loopback host forms on
    // the same port are one listener, so both count as the DSH application.
    function sameLoopbackOrigin(a, b) {
      if (a === b) return true;
      try {
        const left = new URL(a);
        const right = new URL(b);
        return left.protocol === "http:" && left.protocol === right.protocol
          && left.port === right.port
          && LOOPBACK_HOSTS.includes(left.hostname) && LOOPBACK_HOSTS.includes(right.hostname);
      } catch { return false; }
    }
    function parseAddress(input, applicationOrigin) {
      const trimmed = String(input ?? "").trim();
      if (trimmed === "") return { ok: false, reason: "empty" };
      if (trimmed.length > 8192) return { ok: false, reason: "invalid" };
      const candidate = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed) ? trimmed : `https://${trimmed}`;
      let url;
      try { url = new URL(candidate); } catch { return { ok: false, reason: "invalid" }; }
      if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
      if (!ALLOWED_SCHEMES.has(url.protocol)) return { ok: false, reason: "protocol" };
      if (applicationOrigin && applicationOrigin !== "null") {
        try {
          const appOrigin = new URL(applicationOrigin).origin;
          if (url.origin === appOrigin || sameLoopbackOrigin(url.origin, appOrigin)) return { ok: false, reason: "application-origin" };
        } catch {}
      }
      return { ok: true, url: url.href, title: url.hostname };
    }

    // Agent pointer, modeled on Codex's visible cursor: hidden until the
    // first agent action, then shown and left at its last position. Supports
    // a pressed state for click/drag. Position persists per page via
    // window.__ebCursorX/Y for continuous movement.
    const AGENT_CURSOR_JS = `
      var __ebEnsureCursor = function() {
        var cur = document.getElementById("__eb_agent_cursor");
        if (!cur) {
          cur = document.createElement("div");
          cur.id = "__eb_agent_cursor";
          cur.style.cssText = "position:fixed;left:0;top:0;width:20px;height:20px;z-index:2147483647;pointer-events:none;will-change:transform,opacity;opacity:0;transition:opacity .2s ease;";
          cur.innerHTML = "<div class=\\"__eb_ring\\" style=\\"position:absolute;left:-9px;top:-9px;width:38px;height:38px;border-radius:50%;background:rgba(28,120,255,.22);opacity:0;transition:opacity .12s ease;\\"></div>" +
            "<svg viewBox=\\"0 0 24 24\\" width=\\"20\\" height=\\"20\\" style=\\"transition:transform .1s ease;\\"><path d=\\"M5 3l14 8.5-6.4 1.3L9.5 19z\\" fill=\\"#111\\" stroke=\\"#fff\\" stroke-width=\\"1.5\\"/></svg>";
          (document.body || document.documentElement).appendChild(cur);
          var sx0 = typeof window.__ebCursorX === "number" ? window.__ebCursorX : window.innerWidth * 0.75;
          var sy0 = typeof window.__ebCursorY === "number" ? window.__ebCursorY : window.innerHeight * 0.3;
          cur.style.transform = "translate(" + sx0 + "px," + sy0 + "px)";
        }
        return cur;
      };
      var __ebShowCursor = function() {
        __ebEnsureCursor().style.opacity = "1";
      };
      var __ebSetPressed = function(down) {
        var cur = document.getElementById("__eb_agent_cursor");
        if (!cur) return;
        var svg = cur.querySelector("svg");
        var ring = cur.querySelector(".__eb_ring");
        if (svg) svg.style.transform = down ? "scale(0.8)" : "";
        if (ring) ring.style.opacity = down ? "1" : "0";
      };
      var __ebMoveCursor = function(x, y, done) {
        var cur = __ebEnsureCursor();
        var sx = typeof window.__ebCursorX === "number" ? window.__ebCursorX : window.innerWidth * 0.75;
        var sy = typeof window.__ebCursorY === "number" ? window.__ebCursorY : window.innerHeight * 0.3;
        var start = performance.now();
        var step = function(now) {
          var k = Math.min(1, (now - start) / 380);
          var e = 1 - Math.pow(1 - k, 3);
          cur.style.transform = "translate(" + (sx + (x - sx) * e) + "px," + (sy + (y - sy) * e) + "px)";
          if (k < 1) { setTimeout(function() { step(performance.now()); }, 16); }
          else { window.__ebCursorX = x; window.__ebCursorY = y; if (done) done(); }
        };
        // setTimeout-driven, NOT rAF: occluded/backgrounded webviews stop
        // firing rAF, which previously hung every scripted action forever.
        setTimeout(function() { step(performance.now()); }, 16);
      };
`;

    // Guest script that glides the agent pointer to a position; cosmetic only
    // and never allowed to break the actual command.
    const cursorGlide = (xJs, yJs) => `${AGENT_CURSOR_JS}__ebShowCursor();return new Promise(function(resolve){__ebMoveCursor(${xJs},${yJs},resolve);});`;

    /* ------------------------------------------------------------------
     * Page snapshot source (executed in guest). Redacts sensitive values
     * at the source before any data leaves the page.
     * ---------------------------------------------------------------- */
    const SNAPSHOT_SOURCE = `
(function(){
  var INTERACTIVE="a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[tabindex]";
  var SENSITIVE={password:true,hidden:true};
  var elements=[],seen=new Set(),idx=0;
  function labelText(el){
    if(el.id){var lab=document.querySelector("label[for="+JSON.stringify(el.id)+"]");if(lab)return lab.innerText.trim().slice(0,80);}
    var wrap=el.closest("label");if(wrap)return wrap.innerText.trim().slice(0,80);
    return (el.getAttribute("aria-label")||el.getAttribute("title")||el.getAttribute("placeholder")||el.alt||el.innerText||"").trim().slice(0,80);
  }
  function collect(){
    var out=[];seen=new Set();idx=0;
    Array.prototype.forEach.call(document.querySelectorAll(INTERACTIVE),function(el){
      if(seen.has(el))return;seen.add(el);
      var rect=el.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return;
      var tag=el.tagName.toLowerCase();var type=(el.getAttribute("type")||"").toLowerCase();
      var sensitive=!!SENSITIVE[type];
      var value="";
      if((tag==="input"||tag==="textarea")&&!sensitive)value=(el.value||"").slice(0,80);
      out.push({id:"e"+(idx++),tag:tag,type:type||undefined,role:el.getAttribute("role")||undefined,label:labelText(el)||undefined,href:tag==="a"?el.getAttribute("href"):undefined,value:value||undefined,sensitive:sensitive||undefined,disabled:el.disabled||undefined});
    });
    return out;
  }
  var text=(document.body?document.body.innerText:"").replace(/\\s+/g," ").trim().slice(0,4000);
  return {title:document.title||"",text:text,elements:collect().slice(0,200)};
})()`;

    /* ------------------------------------------------------------------
     * Guest controller: wraps one webview guest reservation.
     * ---------------------------------------------------------------- */
    class GuestController {
      constructor(desktop, workspaceKey, tabId, userAgent = null) {
        this.desktop = desktop;
        this.workspaceKey = workspaceKey;
        this.tabId = tabId;
        // Mobile emulation: a non-null UA is applied to the guest before its
        // first navigation; the guest is recreated when the mode changes
        // because the platform applies the attribute at guest creation.
        this.userAgent = userAgent;
        this.lease = null;
        this.partition = null;
        this.element = null;
        this.listeners = [];
        this.mount = null;
        this.released = false;
        this.domReady = false;
        this.acquirePromise = null;
        this.releasePromise = null;
      }
      async acquire() {
        if (this.released) throw new Error("guest-released");
        if (this.lease) return;
        if (this.acquirePromise) return this.acquirePromise;
        this.acquirePromise = this.acquireLease();
        try { await this.acquirePromise; } finally { this.acquirePromise = null; }
      }
      async acquireLease() {
        const reservation = await this.desktop.acquire(this.workspaceKey);
        if (this.released) {
          try { await this.desktop.release(reservation.lease); } catch { /* bridge cleanup is best-effort */ }
          return;
        }
        this.lease = reservation.lease;
        this.partition = reservation.partition;
      }
      addListener(name, listener) {
        if (!this.element || this.released) return;
        this.element.addEventListener(name, listener);
        this.listeners.push([name, listener]);
      }
      async release() {
        if (this.releasePromise) return this.releasePromise;
        this.released = true;
        this.releasePromise = (async () => {
          if (this.acquirePromise) { try { await this.acquirePromise; } catch { /* acquisition failed; nothing to release */ } }
          for (const [name, listener] of this.listeners.splice(0)) this.element?.removeEventListener(name, listener);
          this.element?.remove();
          const lease = this.lease;
          this.lease = null; this.partition = null; this.element = null; this.mount = null;
          if (lease) { try { await this.desktop.release(lease); } catch { /* bridge cleanup is best-effort */ } }
        })();
        return this.releasePromise;
      }
      createElement() {
        if (this.released || !this.lease) throw new Error("guest-lease-unavailable");
        const el = document.createElement("webview");
        el.className = "eb-webview";
        el.setAttribute("name", this.lease);
        el.setAttribute("partition", this.partition);
        // The Desktop main process only approves an about:blank bootstrap whose
        // fragment is a live lease; any other initial src is prevented from
        // attaching. Real navigation happens via loadURL after dom-ready.
        el.setAttribute("src", "about:blank#" + this.lease);
        if (this.userAgent) el.setAttribute("useragent", this.userAgent);
        // Agent commands must work even while the panel is hidden (collapsed
        // sidebar, another session on screen): occluded/backgrounded webviews
        // throttle rAF and timers, which used to hang every scripted action.
        el.setAttribute("webpreferences", "disableBackgroundTimerThrottling=true,disableBackgroundingOccludedWindows=true,disableRendererBackgrounding=true");
        el.dataset.dshBrowserFrame = "webview";
        this.element = el;
        return el;
      }
      // Resolves once the guest finished its initial attach and dom-ready;
      // rejects on destroy or timeout. Electron webview methods that touch
      // the guest (loadURL, executeJavaScript, goBack) require this state.
      ready(timeoutMs = 15000) {
        if (!this.element || this.released) return Promise.reject(new Error("guest-not-mounted"));
        if (this.domReady) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const element = this.element;
          const timer = setTimeout(() => { cleanup(); reject(new Error("guest-ready-timeout")); }, timeoutMs);
          const onReady = () => { cleanup(); resolve(); };
          const onGone = () => { cleanup(); reject(new Error("guest-destroyed")); };
          function cleanup() {
            clearTimeout(timer);
            element?.removeEventListener("dom-ready", onReady);
            element?.removeEventListener("destroyed", onGone);
          }
          element?.addEventListener("dom-ready", onReady);
          element?.addEventListener("destroyed", onGone);
        });
      }
      async execute(source, userGesture = false) {
        if (!this.element || this.released) throw new Error("guest-not-mounted");
        await this.ready();
        const element = this.element;
        // Execution budget: a busy renderer (animated backgrounds, heavy SPA
        // editors) can leave executeJavaScript pending for minutes. Cap it so
        // commands fail fast and the caller can retry or fall back instead of
        // hanging the whole tool call.
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("guest-execute-timeout")), 25000));
        timeout.catch(() => { /* the losing side of the race is expected */ });
        return Promise.race([element.executeJavaScript(source, userGesture), timeout]);
      }
    }

    /* ------------------------------------------------------------------
     * Host bridge (long-poll HTTP command channel).
     * ---------------------------------------------------------------- */
    class HostBridge {
      constructor(sessionId, applicationOrigin) {
        this.sessionId = sessionId;
        this.applicationOrigin = applicationOrigin;
        this.baseUrl = location.origin + API_PATH;
        this.clientId = crypto.randomUUID();
        if (location.origin !== applicationOrigin) throw new Error("Browser bridge origin does not match the DSH application origin.");
        this.capability = null;
        this.controllers = new Map();
        this.listeners = new Set();
        this.polling = false;
        this.stopped = false;
        this.abortController = null;
        this.registrationPending = null;
        this.registrationAbortController = null;
        this.stopPromise = null;
        this.lastStateVersion = -1;
        this.activeTabId = null;
        // Per-tab navigation log for the history tool (newest first, capped).
        this.history = new Map();
      }
      register() {
        if (location.origin !== this.applicationOrigin) throw new Error("Browser registration origin does not match the DSH application origin.");
        const url = `${this.baseUrl}/register?sessionId=${encodeURIComponent(this.sessionId)}&clientId=${encodeURIComponent(this.clientId)}`;
        const expectedOrigin = this.applicationOrigin;
        this.registrationAbortController = new AbortController();
        const timeout = setTimeout(() => this.registrationAbortController?.abort(), 10000);
        const pending = fetch(url, {
          method: "POST",
          mode: "same-origin",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: this.registrationAbortController.signal,
        }).then(async (response) => {
          if (new URL(response.url).origin !== expectedOrigin) throw new Error("Browser registration was redirected outside the DSH application origin.");
          if (!response.ok) {
            // Surface the server's diagnostic detail so a mis-bound Desktop
            // window can self-report the origin it used against what the Host trusts.
            let detail = "";
            try {
              const body = await response.json();
              if (body && typeof body === "object" && typeof body.error === "string") {
                detail = ` (${body.error}`;
                if (typeof body.expected === "string") detail += `; expected ${body.expected}`;
                if (Object.prototype.hasOwnProperty.call(body, "received")) detail += `, received ${body.received === null ? "none" : body.received}`;
                if (Array.isArray(body.trusted) && body.trusted.length > 0) detail += `; trusted: ${body.trusted.join(", ")}`;
                if (typeof body.reason === "string") detail += `; reason ${body.reason}`;
                if (typeof body.sessionId === "string") detail += `; sessionId ${body.sessionId}`;
                detail += ")";
              }
            } catch { /* response carried no diagnostic body */ }
            throw new Error(`Browser session registration failed (${response.status})${detail} [page origin: ${location.origin}].`);
          }
          const payload = await response.json();
          if (typeof payload?.capability !== "string" || payload.capability === "") throw new Error("Browser session registration returned no capability.");
          this.capability = payload.capability;
          if (this.stopped) {
            // The panel was torn down while registering (e.g. a restored tab
            // replaced by the auto-opened one). Release the session slot so a
            // later instance can connect instead of leaving a dead client
            // holding clientInstance forever.
            try {
              await fetch(this.query("/disconnect"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}), cache: "no-store" });
            } catch { /* best-effort release */ }
            return payload.capability;
          }
          // Start polling ATOMICALLY with a successful registration instead of
          // relying on the component effect to call start() afterwards; this
          // removes a whole class of handoff races where the panel registered
          // but never began polling.
          this.start(payload.capability);
          return payload.capability;
        }).finally(() => {
          clearTimeout(timeout);
          this.registrationAbortController = null;
        });
        this.registrationPending = pending;
        return pending;
      }
      setController(tabId, controller) {
        if (controller && !this.stopped) this.controllers.set(tabId, controller);
        else {
          this.controllers.delete(tabId);
          if (controller) controller.release().catch(() => {});
        }
      }
      controllerFor(tabId) { return this.controllers.get(tabId); }
      // Cold guest mounts (first webview after app start) can exceed 10 s while
      // the main process is busy; wait generously instead of failing fast.
      async waitForController(tabId, timeoutMs = 25000) {
        const deadline = Date.now() + timeoutMs;
        while (!this.stopped && Date.now() < deadline) {
          const controller = this.controllers.get(tabId);
          if (controller?.element && !controller.released) return controller;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(this.stopped ? "browser-session-stopped" : this.controllers.has(tabId) ? "guest-not-ready" : "tab-not-found");
      }
      onState(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
      emitState(state) {
        this.activeTabId = state?.activeTabId ?? null;
        for (const listener of this.listeners) listener(state);
      }
      query(path) {
        if (!this.capability) throw new Error("browser-session-not-authenticated");
        return `${this.baseUrl}${path}?sessionId=${encodeURIComponent(this.sessionId)}&capability=${encodeURIComponent(this.capability)}&clientId=${encodeURIComponent(this.clientId)}`;
      }
      async post(path, body) {
        if (this.stopped) throw new Error("browser-session-stopped");
        const res = await fetch(this.query(path), {
          method: "POST", mode: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
          signal: this.abortController?.signal,
        });
        if (this.dbg) this.dbg.postOk++;
        if (!res.ok) throw new Error(`Host responded ${res.status}`);
        return res.json().catch(() => ({}));
      }
      notePostError(scope, error) {
        if (!this.dbg) return;
        this.dbg.postErr++;
        if (this.dbg.firstErr === null) this.dbg.firstErr = `${scope}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 120);
      }
      async reportEvent(event) { try { await this.post("/event", event); } catch (error) { this.notePostError("event", error); } }
      async reportResult(id, value) { try { await this.post("/result", { id, ok: true, value }); } catch (error) { this.notePostError("result", error); } }
      async reportFailure(id, error) { try { await this.post("/result", { id, ok: false, error }); } catch (e) { this.notePostError("failure", e); } }
      start(capability) {
        if (this.polling || this.stopped) return;
        this.capability = capability;
        this.polling = true;
        this.abortController = new AbortController();
        this.loop();
      }
      stop() {
        if (this.stopPromise) return this.stopPromise;
        this.stopped = true;
        this.stopPromise = (async () => {
          // Registration may still be returning the capability needed for an authenticated disconnect.
          if (this.registrationPending) {
            try { await this.registrationPending; } catch { /* no authenticated disconnect is possible */ }
          }
          if (this.capability) {
            try {
              const response = await fetch(this.query("/disconnect"), {
                method: "POST",
                mode: "same-origin",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              });
              if (!response.ok) throw new Error(`Disconnect returned ${response.status}.`);
            } catch { /* disconnect is best-effort during teardown */ }
          }
          this.registrationAbortController?.abort();
          this.abortController?.abort();
          const controllers = [...this.controllers.entries()];
          this.controllers.clear();
          await Promise.all(controllers.map(async ([tabId, controller]) => {
            try { await controller.release(); } catch { /* guest cleanup is best-effort */ }
            if (this.controllers.get(tabId) === controller) this.controllers.delete(tabId);
          }));
        })();
        return this.stopPromise;
      }
      async loop() {
        while (!this.stopped) {
          try {
            // Advertise the state version we already hold so the Host only
            // re-sends state when it changed; after (re)registration the
            // version is -1 and the full state is always delivered.
            const pollUrl = this.query("/poll") + (this.lastStateVersion >= 0 ? `&since=${this.lastStateVersion}` : "");
            const res = await fetch(pollUrl, { signal: this.abortController.signal });
            if (!res.ok) {
              if (res.status === 401 && !this.stopped) {
                // The Host restarted or recreated the session (plugin reload,
                // app restart): re-register once and keep polling with the
                // fresh capability instead of orphaning the panel.
                try {
                  const capability = await this.register();
                  if (this.stopped) return;
                  this.capability = capability;
                  this.lastStateVersion = -1;
                  continue;
                } catch { /* fall through to backoff */ }
              }
              if (res.status === 409 && !this.stopped) {
                // Another panel instance owns the session now; yield instead
                // of polling forever against a lost registration.
                this.stopped = true;
                this.controllers.clear();
                this.emitState({ tabs: [], activeTabId: null, currentPage: null });
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
              continue;
            }
            const payload = await res.json();
            if (payload.state && payload.stateVersion !== this.lastStateVersion) {
              this.lastStateVersion = payload.stateVersion;
              this.emitState(payload.state);
            }
            if (payload.command) this.executeCommand(payload.command);
          } catch (error) {
            if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        this.polling = false;
      }
      async executeCommand(command) {
        try { const value = await this.perform(command.kind, command.args); await this.reportResult(command.id, value); }
        catch (error) { await this.reportFailure(command.id, { code: "client-command-failed", message: error instanceof Error ? error.message : String(error) }); }
      }
      async perform(kind, args) {
        const tabId = args?.tabId;
        if (typeof tabId !== "string" || tabId === "") throw new Error("tab-id-required");
        if (kind === "clearData" && tabId !== this.activeTabId) throw new Error("clear-data-requires-active-tab");
        const controller = kind === "closeTab" ? this.controllerFor(tabId) : await this.waitForController(tabId);
        if (!controller) throw new Error("tab-not-found");
        if (kind === "closeTab") {
          if (controller) await controller.release();
          this.setController(tabId, null);
          return { message: "Tab closed." };
        }
        switch (kind) {
          case "navigate": {
            await controller.ready();
            // Show the pointer gliding to the page's address area before acting.
            await controller.execute(cursorGlide("window.innerWidth/2", "72"), true).catch(() => {});
            if (args.action) {
              const el = controller.element; if (!el) throw new Error("guest-not-ready");
              if (args.action === "back") el.goBack(); else if (args.action === "forward") el.goForward(); else if (args.action === "refresh") el.reload(); else throw new Error("unknown-action");
              return { message: `Performed ${args.action}.` };
            }
            const parsed = parseAddress(args.url, this.applicationOrigin);
            if (!parsed.ok) throw new Error(`address-rejected: ${parsed.reason}`);
            if (!controller.element) throw new Error("guest-not-ready");
            await controller.element.loadURL(parsed.url);
            return { message: `Navigated to ${parsed.url}.` };
          }
          case "clearData": {
            if (tabId !== this.activeTabId) throw new Error("clear-data-requires-active-tab");
            await controller.ready();
            const el = controller.element;
            if (!el || typeof el.clearData !== "function") throw new Error("guest-clear-data-unavailable");
            await el.clearData({ storages: ["cookies", "localstorage", "cache", "serviceworkers"] });
            return { message: "Requested data clearing from this guest. The runtime-dependent scope is not a guarantee that all browser data was cleared." };
          }
          case "snapshot": {
            const snapshot = await controller.execute(SNAPSHOT_SOURCE, false);
            await this.reportEvent({ kind: "tab-update", tabId: args.tabId, snapshot });
            return { snapshot };
          }
          case "scroll": {
            const dx = args.x ?? (args.direction === "left" ? -(args.amount ?? 300) : args.direction === "right" ? (args.amount ?? 300) : 0);
            const dy = args.y ?? (args.direction === "up" ? -(args.amount ?? 300) : args.direction === "down" ? (args.amount ?? 300) : 0);
            // Glide to the viewport center, then scroll in steps while the
            // pointer rolls like a wheel, so the scroll is visibly a mouse op.
            await controller.execute(`(function(){
${AGENT_CURSOR_JS}
              __ebShowCursor();
              return new Promise(function(resolve){
                __ebMoveCursor(window.innerWidth/2, window.innerHeight/2, function(){
                  var steps = 6, i = 0, baseY = window.__ebCursorY;
                  function one(){
                    window.scrollBy(${JSON.stringify(dx)}/steps, ${JSON.stringify(dy)}/steps);
                    var cur = document.getElementById("__eb_agent_cursor");
                    var jiggle = (i % 2 === 0) ? -10 : 10;
                    if (cur) cur.style.transform = "translate(" + window.__ebCursorX + "px," + (baseY + jiggle) + "px)";
                    i++;
                    if (i < steps) { setTimeout(one, 60); }
                    else {
                      if (cur) cur.style.transform = "translate(" + window.__ebCursorX + "px," + baseY + "px)";
                      window.__ebCursorY = baseY;
                      resolve(true);
                    }
                  }
                  one();
                });
              });
            })()`, true).catch(() => {});
            return { message: `Scrolled by (${dx}, ${dy}).` };
          }
          case "click": {
            // CSS-selector path: no snapshot id needed, same visible cursor
            // glide + pressed-state click as the element-id path.
            if (typeof args.selector === "string" && args.selector) {
              const picked = await controller.execute(`(function(){
${AGENT_CURSOR_JS}
                var target = document.querySelector(${JSON.stringify(args.selector)});
                if (!target) return "missing";
                target.scrollIntoView({ block: "center" });
                var rect = target.getBoundingClientRect();
                if (!(rect.width > 0 && rect.height > 0)) return "hidden";
                var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
                return new Promise(function(resolve){
                  __ebShowCursor();
                  __ebMoveCursor(cx, cy, function(){
                    __ebSetPressed(true);
                    target.click();
                    setTimeout(function(){ __ebSetPressed(false); }, 70);
                    ${args.double ? `setTimeout(function(){
                      __ebSetPressed(true);
                      target.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true,view:window,button:0}));
                      setTimeout(function(){ __ebSetPressed(false); resolve("clicked"); }, 70);
                    }, 140);` : `setTimeout(function(){ resolve("clicked"); }, 70);`}
                  });
                });
              })()`, true);
              if (picked !== "clicked") throw new Error(`element-not-found: selector ${args.selector} matched no visible element (${picked}).`);
              await this.reportEvent({ kind: "tab-update", tabId: args.tabId, snapshot: await controller.execute(SNAPSHOT_SOURCE, false) });
              return { message: `Clicked ${args.selector}.` };
            }
            const tStart = performance.now();
            const snapshot = await controller.execute(SNAPSHOT_SOURCE, false);
            const tSnap = performance.now() - tStart; const index = (snapshot?.elements || []).findIndex((entry) => entry.id === args.elementId); const tAct = performance.now();
            if (index < 0) throw new Error("element-not-found: the element id is stale; run snapshot again.");
            const result = await controller.execute(`(function(){
${AGENT_CURSOR_JS}
              var INTERACTIVE="a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[tabindex]";
              var seen=new Set();
              var els=Array.prototype.filter.call(document.querySelectorAll(INTERACTIVE),function(el){
                if(seen.has(el))return false;seen.add(el);
                var rect=el.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return false;
                return true;
              });
              var target=els[${JSON.stringify(index)}];
              if(!target)return "missing";
              target.scrollIntoView({block:"center"});
              var rect=target.getBoundingClientRect();
              var cx=rect.left+rect.width/2;
              var cy=rect.top+rect.height/2;
              return new Promise(function(resolve){
                __ebShowCursor();
                __ebMoveCursor(cx,cy,function(){
                  __ebSetPressed(true);
                  target.click();
                  setTimeout(function(){ __ebSetPressed(false); }, 70);
                  ${args.double ? `setTimeout(function(){
                    __ebSetPressed(true);
                    target.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true,view:window,button:0}));
                    setTimeout(function(){ __ebSetPressed(false); resolve("clicked"); }, 70);
                  }, 140);` : `setTimeout(function(){ resolve("clicked"); }, 70);`}
                });
              });
            })()`, true);
            if (result !== "clicked") throw new Error("element-not-found: target element no longer exists.");
            await this.reportEvent({ kind: "tab-update", tabId: args.tabId, snapshot: await controller.execute(SNAPSHOT_SOURCE, false) });
            return { message: `Clicked element ${args.elementId}. (snapshot ${Math.round(tSnap)}ms, action ${Math.round(performance.now() - tAct)}ms)` };
          }
          case "type": {
            // CSS-selector path: native value commit on the matched input,
            // with the visible cursor glide.
            if (typeof args.selector === "string" && args.selector) {
              const typed = await controller.execute(`(function(){
${AGENT_CURSOR_JS}
                var target = document.querySelector(${JSON.stringify(args.selector)});
                if (!target) return "missing";
                target.scrollIntoView({ block: "center" });
                var rect = target.getBoundingClientRect();
                if (!(rect.width > 0 && rect.height > 0)) return "hidden";
                return new Promise(function(resolve){
                  __ebShowCursor();
                  __ebMoveCursor(rect.left + Math.min(rect.width / 2, 90), rect.top + rect.height / 2, function(){
                    target.focus();
                    var proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
                    setter.call(target, ${JSON.stringify(args.text)});
                    target.dispatchEvent(new Event("input", { bubbles: true }));
                    target.dispatchEvent(new Event("change", { bubbles: true }));
                    if (${args.submit ? "true" : "false"}) {
                      for (const evtType of ["keydown", "keypress", "keyup"]) {
                        target.dispatchEvent(new KeyboardEvent(evtType, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
                      }
                      if (target.form) target.form.submit();
                    }
                    resolve("typed");
                  });
                });
              })()`, true);
              if (typed !== "typed") throw new Error(`element-not-found: selector ${args.selector} matched no visible input (${typed}).`);
              await this.reportEvent({ kind: "tab-update", tabId: args.tabId, snapshot: await controller.execute(SNAPSHOT_SOURCE, false) });
              return { message: `Typed into ${args.selector}.` };
            }
            const tStart = performance.now();
            const snapshot = await controller.execute(SNAPSHOT_SOURCE, false);
            const tSnap = performance.now() - tStart; const match = (snapshot?.elements || []).find((entry) => entry.id === args.elementId); const tAct = performance.now();
            if (!match) throw new Error("element-not-found: the element id is stale; run snapshot again.");
            // Sensitive fields (e.g. password) are fillable like any other
            // input: the value travels as the tool argument, while snapshots
            // and state keep redacting it.
            const index = (snapshot?.elements || []).indexOf(match);
            const result = await controller.execute(`(function(){
${AGENT_CURSOR_JS}
              var INTERACTIVE="a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[tabindex]";
              var seen=new Set();
              var els=Array.prototype.filter.call(document.querySelectorAll(INTERACTIVE),function(el){
                if(seen.has(el))return false;seen.add(el);
                var rect=el.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return false;
                return true;
              });
              var target=els[${JSON.stringify(index)}];
              if(!target)return "missing";
              target.scrollIntoView({block:"center"});
              var rect=target.getBoundingClientRect();
              var cx=rect.left+Math.min(rect.width/2,90);
              var cy=rect.top+rect.height/2;
              return new Promise(function(resolve){
                __ebShowCursor();
                __ebMoveCursor(cx,cy,function(){
                  target.focus();
                  // Use the native value setter so React-controlled inputs register
                  // the change in their state; a plain assignment is ignored by
                  // React's value tracker and leaves the component stale.
                  var proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
                  setter.call(target, ${JSON.stringify(args.text)});
                  target.dispatchEvent(new Event("input",{bubbles:true}));
                  target.dispatchEvent(new Event("change",{bubbles:true}));
                  if(${args.submit ? "true" : "false"}){
                    for (const evtType of ["keydown","keypress","keyup"]) {
                      target.dispatchEvent(new KeyboardEvent(evtType,{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true}));
                    }
                    if(target.form)target.form.submit();
                  }
                  resolve("typed");
                });
              });
            })()`, true);
            if (result !== "typed") throw new Error("element-not-found: target element no longer exists.");
            await this.reportEvent({ kind: "tab-update", tabId: args.tabId, snapshot: await controller.execute(SNAPSHOT_SOURCE, false) });
            return { message: `Typed into element ${args.elementId}. (snapshot ${Math.round(tSnap)}ms, action ${Math.round(performance.now() - tAct)}ms)` };
          }
          case "setDevice": {
            if (typeof this.applyDevice !== "function") throw new Error("device-handler-unavailable");
            const next = await this.applyDevice(args.tabId, { mobile: args.mobile, width: args.width });
            return { message: `Device mode: ${next.mobile ? "mobile" : "desktop"} at ${next.width}px.`, mobile: next.mobile, width: next.width };
          }
          case "setZoom": {
            await controller.ready();
            const el = controller.element;
            if (!el) throw new Error("guest-not-ready");
            if (args.factor === undefined || args.factor === null) {
              const current = typeof el.getZoomFactor === "function" ? el.getZoomFactor() : 1;
              return { message: `Current zoom: ${current}.`, factor: current };
            }
            const factor = Math.min(3, Math.max(0.25, Number(args.factor)));
            if (typeof el.setZoomFactor === "function") el.setZoomFactor(factor);
            return { message: `Zoom set to ${factor}.`, factor };
          }
          case "hover": {
            const snapshot = await controller.execute(SNAPSHOT_SOURCE, false);
            const index = (snapshot?.elements || []).findIndex((entry) => entry.id === args.elementId);
            if (index < 0) throw new Error("element-not-found: the element id is stale; run snapshot again.");
            const result = await controller.execute(`(function(){
${AGENT_CURSOR_JS}
              var INTERACTIVE="a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[tabindex]";
              var seen=new Set();
              var els=Array.prototype.filter.call(document.querySelectorAll(INTERACTIVE),function(el){
                if(seen.has(el))return false;seen.add(el);
                var rect=el.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return false;
                return true;
              });
              var target=els[${JSON.stringify(index)}];
              if(!target)return "missing";
              target.scrollIntoView({block:"center"});
              var rect=target.getBoundingClientRect();
              return new Promise(function(resolve){
                __ebShowCursor();
                __ebMoveCursor(rect.left+rect.width/2, rect.top+rect.height/2, function(){
                  for (const type of ["pointerover","mouseover","mouseenter","pointermove","mousemove"]) {
                    target.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type,{bubbles:true,cancelable:true,view:window}));
                  }
                  resolve("hovered");
                });
              });
            })()`, true);
            if (result !== "hovered") throw new Error("element-not-found: target element no longer exists.");
            return { message: `Hovered element ${args.elementId}.` };
          }
          case "press": {
            const KEY = PRESS_KEY_DEFS[args.key];
            if (!KEY) throw new Error(`unknown-key: ${String(args.key)}`);
            let focusScript = "var target=document.activeElement||document.body;";
            if (args.elementId) {
              const snapshot = await controller.execute(SNAPSHOT_SOURCE, false);
              const index = (snapshot?.elements || []).findIndex((entry) => entry.id === args.elementId);
              if (index < 0) throw new Error("element-not-found: the element id is stale; run snapshot again.");
              focusScript = `var seen=new Set();
              var els=Array.prototype.filter.call(document.querySelectorAll("a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[tabindex]"),function(el){
                if(seen.has(el))return false;seen.add(el);
                var rect=el.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return false;
                return true;
              });
              var target=els[${JSON.stringify(index)}]||document.activeElement||document.body;
              target.scrollIntoView({block:"center"});target.focus();`;
            }
            const result = await controller.execute(`(function(){
${AGENT_CURSOR_JS}
              ${focusScript}
              var rect=target.getBoundingClientRect?target.getBoundingClientRect():{left:innerWidth/2,top:innerHeight/2,width:0,height:0};
              var cx=rect.left+rect.width/2, cy=rect.top+rect.height/2;
              return new Promise(function(resolve){
                __ebShowCursor();
                __ebMoveCursor(cx,cy,function(){
                  for (const type of ["keydown","keypress","keyup"]) {
                    target.dispatchEvent(new KeyboardEvent(type,{key:${JSON.stringify(KEY.key)},code:${JSON.stringify(KEY.code || KEY.key)},keyCode:${KEY.keyCode},which:${KEY.keyCode},bubbles:true,cancelable:true,view:window}));
                  }
                  resolve("pressed");
                });
              });
            })()`, true);
            if (result !== "pressed") throw new Error("press-failed: target element no longer exists.");
            return { message: `Pressed ${args.key}.` };
          }
          case "drag": {
            if (!args.fromElementId || !args.toElementId) throw new Error("drag requires from_element_id and to_element_id");
            const snapshot = await controller.execute(SNAPSHOT_SOURCE, false);
            const fromIndex = (snapshot?.elements || []).findIndex((entry) => entry.id === args.fromElementId);
            const toIndex = (snapshot?.elements || []).findIndex((entry) => entry.id === args.toElementId);
            if (fromIndex < 0 || toIndex < 0) throw new Error("element-not-found: stale element ids; run snapshot again.");
            const result = await controller.execute(`(function(){
${AGENT_CURSOR_JS}
              var INTERACTIVE="a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[tabindex]";
              var seen=new Set();
              var els=Array.prototype.filter.call(document.querySelectorAll(INTERACTIVE),function(el){
                if(seen.has(el))return false;seen.add(el);
                var rect=el.getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return false;
                return true;
              });
              var source=els[${JSON.stringify(fromIndex)}];
              var targetEl=els[${JSON.stringify(toIndex)}];
              if(!source||!targetEl)return "missing";
              source.scrollIntoView({block:"center"});
              targetEl.scrollIntoView({block:"center"});
              var a=source.getBoundingClientRect(), b=targetEl.getBoundingClientRect();
              var sx=a.left+a.width/2, sy=a.top+a.height/2, tx=b.left+b.width/2, ty=b.top+b.height/2;
              function fire(el, type, x, y, Ctor) {
                el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" || type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
              }
              return new Promise(function(resolve){
                __ebShowCursor();
                __ebMoveCursor(sx, sy, function(){
                  __ebSetPressed(true);
                  fire(source, "pointerdown", sx, sy, PointerEvent);
                  fire(source, "mousedown", sx, sy, MouseEvent);
                  var start = performance.now(), dur = 520;
                  // Timer-driven, NOT rAF: occluded/backgrounded webviews stop
                  // firing rAF, which previously hung the drag forever.
                  function step() {
                    var now = performance.now();
                    var k = Math.min(1, (now - start) / dur);
                    var x = sx + (tx - sx) * k, y = sy + (ty - sy) * k;
                    var under = document.elementFromPoint(x, y) || targetEl;
                    fire(under, "pointermove", x, y, PointerEvent);
                    fire(under, "mousemove", x, y, MouseEvent);
                    var cur = document.getElementById("__eb_agent_cursor");
                    if (cur) cur.style.transform = "translate(" + x + "px," + y + "px)";
                    if (k < 1) { setTimeout(step, 16); }
                    else {
                      window.__ebCursorX = tx; window.__ebCursorY = ty;
                      fire(targetEl, "pointerup", tx, ty, PointerEvent);
                      fire(targetEl, "mouseup", tx, ty, MouseEvent);
                      fire(targetEl, "click", tx, ty, MouseEvent);
                      __ebSetPressed(false);
                      resolve("dragged");
                    }
                  }
                  setTimeout(step, 16);
                });
              });
            })()`, true);
            if (result !== "dragged") throw new Error("element-not-found: drag target no longer exists.");
            await this.reportEvent({ kind: "tab-update", tabId: args.tabId, snapshot: await controller.execute(SNAPSHOT_SOURCE, false) });
            return { message: `Dragged ${args.fromElementId} to ${args.toElementId}.` };
          }
          case "evaluate": {
            if (typeof args.expression !== "string" || args.expression.length === 0 || args.expression.length > 4000) throw new Error("invalid-expression");
            // Two wrapping strategies: the input is FIRST treated as one
            // expression (the common case). A SyntaxError there means the
            // input was statement-style (top-level const/var/multi-line), NOT
            // that the engine is old — fall back to evaluating it as a body
            // (last-value semantics), which accepts any modern JS.
            const runWrapped = (bodyExpr) => controller.execute(`(async function(){
              try {
                const value = await (${bodyExpr});
                function sanitize(v, d) {
                  if (d > 4) return "[depth]";
                  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
                  if (typeof v === "string") return v.slice(0, 4000);
                  if (typeof v === "undefined") return "[undefined]";
                  if (typeof v === "bigint") return String(v);
                  if (typeof v === "function") return "[function]";
                  if (Array.isArray(v)) return v.slice(0, 100).map(function (x) { return sanitize(x, d + 1); });
                  if (typeof v === "object") { const o = {}; Object.keys(v).slice(0, 100).forEach(function (k) { try { o[k] = sanitize(v[k], d + 1); } catch (e) { o[k] = "[unreadable]"; } }); return o; }
                  return String(v);
                }
                return { ok: true, value: sanitize(value, 0) };
              } catch (error) {
                return { ok: false, error: String((error && error.message) || error) };
              }
            })()`, false);
            let raw = await runWrapped(args.expression);
            if (raw && raw.ok === false && /SyntaxError/.test(String(raw.error))) {
              raw = await runWrapped(`function(){ "use strict"; return eval(${JSON.stringify(args.expression)}); }()`);
            }
            return raw ?? { ok: false, error: "no-result" };
          }
          case "resources": {
            const data = await controller.execute(`({
              scripts: Array.prototype.map.call(document.querySelectorAll("script[src]"), function (s) { return s.src; }),
              styles: Array.prototype.map.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) { return l.href; }),
              inlineScripts: Array.prototype.filter.call(document.querySelectorAll("script:not([src])"), function (s) { return s.textContent && s.textContent.trim().length > 0; }).length,
              inlineStyles: Array.prototype.filter.call(document.querySelectorAll("style"), function (s) { return s.textContent && s.textContent.trim().length > 0; }).length
            })`, false);
            return data ?? { scripts: [], styles: [], inlineScripts: 0, inlineStyles: 0 };
          }
          case "console": {
            const entries = await controller.execute(`(window.__ebConsole || [])`, false);
            return { entries: Array.isArray(entries) ? entries : [], message: Array.isArray(entries) && entries.length > 0 ? `${entries.length} recent console/error entries.` : "No captured console errors." };
          }
          case "history": {
            return { entries: this.history.get(tabId) ?? [] };
          }
          case "wait": {
            const seconds = Math.min(30, Math.max(0.5, Number(args.seconds) || 1));
            const deadline = Date.now() + seconds * 1000;
            const probe = args.selector
              ? `!!document.querySelector(${JSON.stringify(String(args.selector))})`
              : args.text
                ? `((document.body && document.body.innerText) || "").includes(${JSON.stringify(String(args.text))})`
                : null;
            if (!probe) {
              await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
              return { message: `Waited ${seconds}s.`, matched: true };
            }
            while (Date.now() < deadline) {
              const hit = await controller.execute(probe, false).catch(() => false);
              if (hit === true) return { message: `Condition met within ${seconds}s.`, matched: true };
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            return { message: `Timed out after ${seconds}s waiting for the condition.`, matched: false };
          }
          case "screenshot": {
            await controller.ready();
            const el = controller.element;
            if (!el || typeof el.capturePage !== "function") throw new Error("guest-capture-unavailable");
            // Let the compositor settle so tiles are fully rasterized; without
            // this, parts of the capture come out blurred. rAF is NOT used
            // here: it never fires in occluded webviews and used to hang the
            // screenshot until the tool timeout.
            await new Promise((resolve) => setTimeout(resolve, 900));
            const image = await el.capturePage();
            const dataUrl = image.toDataURL("image/png");
            const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
            const res = await fetch(this.query("/shot"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ png: base64 }),
            });
            if (!res.ok) throw new Error(`screenshot upload failed: HTTP ${res.status}`);
            return await res.json();
          }
          case "batch": {
            return await this.performBatch(tabId, args.steps);
          }
          default: throw new Error(`unknown-command: ${kind}`);
        }
      }
      // Run several actions sequentially in ONE command (Codex-style batch):
      // each step reuses perform(), failures abort the rest and report the
      // failing step index. Tool-facing snake_case keys map to the camelCase
      // params perform() expects.
      async performBatch(tabId, steps) {
        if (!Array.isArray(steps) || steps.length === 0 || steps.length > 20) throw new Error("invalid-steps: 1-20 steps");
        const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const results = [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const kind = step && step.do;
          if (typeof kind !== "string") {
            results.push({ index: i, ok: false, error: "step missing 'do'" });
            return { results, failedAt: i };
          }
          const params = { tabId };
          for (const [key, value] of Object.entries(step)) {
            if (key === "do") continue;
            params[key.includes("_") ? camel(key) : key] = value;
          }
          try {
            const value = await this.perform(kind, params);
            let preview = value;
            try {
              const text = JSON.stringify(value);
              preview = text && text.length > 2000 ? text.slice(0, 2000) + "…[truncated]" : value;
            } catch { preview = "[unserializable]"; }
            results.push({ index: i, do: kind, ok: true, value: preview });
          } catch (error) {
            results.push({ index: i, do: kind, ok: false, error: error instanceof Error ? error.message : String(error) });
            return { results, failedAt: i };
          }
        }
        return { results, completed: true };
      }
    }

    /* ------------------------------------------------------------------
     * Icons
     * ---------------------------------------------------------------- */
    const icon = (paths) => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true }, paths);
    const IconBack = () => icon(h("path", { d: "M10 3L5 8l5 5", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));
    const IconForward = () => icon(h("path", { d: "M6 3l5 5-5 5", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));
    const IconRefresh = () => icon(h("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 2v3h-3", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }));
    const IconGlobe = () => h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true }, h("circle", { cx: 8, cy: 8, r: 6, stroke: "currentColor", strokeWidth: 1 }), h("path", { d: "M2 8h12M8 2c1.5 1.6 2 3.6 2 6s-.5 4.4-2 6c-1.5-1.6-2-3.6-2-6s.5-4.4 2-6z", stroke: "currentColor", strokeWidth: 1 }));
    const IconPlus = () => icon(h("path", { d: "M8 3v10M3 8h10", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }));
    const IconPhone = () => h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.2, "aria-hidden": true },
      h("rect", { x: 5, y: 2, width: 6, height: 12, rx: 1.2 }),
      h("path", { d: "M7 12.5h2", strokeLinecap: "round" }));
    const IconDots = () => icon(h("path", { d: "M4 8h.01M8 8h.01M12 8h.01", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }));
    const IconCheck = () => icon(h("path", { d: "M3 8.5l3.2 3L13 4.5", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }));

    /* ------------------------------------------------------------------
     * Components
     * ---------------------------------------------------------------- */
    function BrowserBody({ useTabInfo, t, sessionId: injectedSessionId }) {
      ensureCss();
      // The slot injects sessionId directly; Desktop tab info may lack it.
      // Resolve defensively across both shapes before touching the bridge.
      const tabInfo = useTabInfo();
      const sessionId = injectedSessionId ?? tabInfo?.sessionId ?? tabInfo?.tab?.sessionId;
      const desktopCarrier = typeof globalThis !== "undefined" ? globalThis.dshDesktop : undefined;
      const desktop = desktopCarrier && desktopCarrier.protocolVersion === 1 ? desktopCarrier.browser : undefined;
      const bridgeRef = React.useRef(null);
      const [hostState, setHostState] = React.useState({ tabs: [], activeTabId: null, currentPage: null });
      const [draft, setDraft] = React.useState("");
      const [error, setError] = React.useState(null);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [resolutionOpen, setResolutionOpen] = React.useState(false);
      const [resDraft, setResDraft] = React.useState({ w: 1920, h: 1080 });
      const viewportRef = React.useRef(null);
      const [frameScales, setFrameScales] = React.useState({});

      // Module-level registry entry for the auto-present poller (created once
      // per mounted body; lives in a ref so both the effect and the DOM ref
      // callback can reach the same object).
      const registryEntryRef = React.useRef(null);
      if (registryEntryRef.current === null) registryEntryRef.current = { sessionId: sessionId || null, node: null };
      React.useEffect(() => {
        let bridge;
        let unsubscribe = () => {};
        panelRegistry.add(registryEntryRef.current);
        try {
          if (!sessionId) throw new Error("Browser panel has no session context (sessionId missing from tab info and slot props).");
          bridge = new HostBridge(sessionId, window.location.origin);
          bridge.applyDevice = (tabId, options) => applyDeviceMode(tabId, options);
          bridgeRef.current = bridge;
          unsubscribe = bridge.onState(setHostState);
          // Registration retries with backoff: right after an app restart the
          // agent may not be in the registry yet (register can fail 404
          // no-live-agent). Intermediate failures stay silent; the banner only
          // appears after repeated failures and is cleared on success.
          (async () => {
            for (let attempt = 0; ; attempt++) {
              try {
                const capability = await bridge.register();
                if (!bridge.stopped && bridgeRef.current === bridge) {
                  setError(null);
                  bridge.start(capability);
                }
                return;
              } catch (error) {
                if (bridge.stopped || bridgeRef.current !== bridge) return;
                if (attempt >= 2) setError(error instanceof Error ? error.message : String(error));
                await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 3000 * (attempt + 1))));
              }
            }
          })();
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
        return () => {
          panelRegistry.delete(registryEntryRef.current);
          unsubscribe();
          if (bridge) bridge.stop();
          if (bridgeRef.current === bridge) bridgeRef.current = null;
        };
      }, [sessionId]);

      const activeTabId = hostState.activeTabId;
      const controllerMapRef = React.useRef(new Map());
      const mountNodesRef = React.useRef(new Map());
      // Per-tab device mode: { mobile: boolean, width: number }. Width is a
      // pure layout style on the mount node; the UA requires a guest remount.
      const [deviceModes, setDeviceModes] = React.useState(() => new Map());
      const deviceModesRef = React.useRef(deviceModes);
      deviceModesRef.current = deviceModes;
      // Per-tab virtual resolution { w, h } | null: the guest renders at this
      // size and is scaled to fit the frame (letterboxed like device emulation).
      const [resolutions, setResolutions] = React.useState(() => new Map());
      const resolutionsRef = React.useRef(resolutions);
      resolutionsRef.current = resolutions;
      const dragStateRef = React.useRef(null);
      const tabs = hostState.tabs || [];
      const current = hostState.currentPage;

      // Compute contain-scales for tabs with a virtual resolution.
      const tabIdsKey = tabs.map((entry) => entry.id).join(",");
      React.useEffect(() => {
        const wrap = viewportRef.current;
        if (!wrap) return undefined;
        const compute = () => {
          const out = {};
          for (const entry of tabs) {
            const res = resolutionsRef.current.get(entry.id);
            if (res) out[entry.id] = Math.min(wrap.clientWidth / res.w, wrap.clientHeight / res.h);
          }
          setFrameScales(out);
        };
        compute();
        const observer = new ResizeObserver(compute);
        observer.observe(wrap);
        return () => observer.disconnect();
      }, [tabIdsKey, resolutions]);

      React.useEffect(() => {
        return () => {
          for (const controller of controllerMapRef.current.values()) controller.release().catch(() => {});
          controllerMapRef.current.clear();
          mountNodesRef.current.clear();
        };
      }, [sessionId]);

      function deviceModeFor(tabId) {
        return deviceModesRef.current.get(tabId) ?? DEFAULT_DEVICE_MODE;
      }

      async function mountGuest(entry, controller) {
        controller.mount = mountNodesRef.current.get(entry.id);
        if (!controller.mount) return false;
        controller.initializing = true;
        const bridge = bridgeRef.current;
        try {
          await controller.acquire();
          if (controller.released || controllerMapRef.current.get(entry.id) !== controller || !controller.mount?.isConnected) {
            await controller.release();
            return false;
          }
          const element = controller.createElement();
          controller.mount.appendChild(element);
          bridge?.setController(entry.id, controller);
          if (bridge) installGuestListeners(controller, entry.id, bridge);
          if (entry.url) {
            // loadURL before attach/dom-ready throws synchronously; the main
            // process also only approves the about:blank bootstrap, so the
            // real URL loads only after dom-ready.
            try {
              await controller.ready();
              if (!controller.released && controllerMapRef.current.get(entry.id) === controller && controller.element) {
                await controller.element.loadURL(entry.url).catch(() => {});
              }
            } catch { /* guest vanished or timed out; the address bar can retry */ }
          }
          return true;
        } catch (err) {
          if (!controller.released) setError(err instanceof Error ? err.message : String(err));
          return false;
        } finally {
          controller.initializing = false;
        }
      }

      function newGuestController(tabId) {
        const mode = deviceModeFor(tabId);
        return new GuestController(desktop, `session:${sessionId}`, tabId, mode.mobile ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT);
      }

      React.useEffect(() => {
        const bridge = bridgeRef.current;
        if (!desktop || !bridge || bridge.stopped) return undefined;
        const currentTabIds = new Set(tabs.map((entry) => entry.id));

        // Retain one live WebView for each Host-owned tab, releasing only tabs removed by the Host.
        for (const [tabId, controller] of controllerMapRef.current) {
          if (!currentTabIds.has(tabId)) {
            bridge.setController(tabId, null);
            controllerMapRef.current.delete(tabId);
            controller.release().catch(() => {});
          }
        }

        for (const entry of tabs) {
          let controller = controllerMapRef.current.get(entry.id);
          if (!controller) {
            controller = newGuestController(entry.id);
            controllerMapRef.current.set(entry.id, controller);
          }
          if (!mountNodesRef.current.get(entry.id) || controller.element || controller.released || controller.initializing) continue;
          mountGuest(entry, controller);
        }
        return undefined;
      }, [desktop, tabs, sessionId, bridgeRef.current]);

      // Apply device mode to one tab: width is a pure layout change; a mobile
      // toggle recreates the guest because the UA only applies at creation.
      // Mobile mode and a virtual resolution are mutually exclusive, so
      // enabling mobile clears the resolution for this tab.
      async function applyDeviceMode(tabId, options = {}) {
        const previous = deviceModeFor(tabId);
        const next = {
          mobile: typeof options.mobile === "boolean" ? options.mobile : previous.mobile,
          width: typeof options.width === "number" ? Math.min(820, Math.max(300, Math.round(options.width))) : previous.width,
        };
        if (next.mobile === previous.mobile && next.width === previous.width) return next;
        const modes = new Map(deviceModesRef.current);
        modes.set(tabId, next);
        setDeviceModes(modes);
        if (next.mobile && resolutionsRef.current.has(tabId)) applyResolution(tabId, null);
        if (next.mobile === previous.mobile) return next;
        const bridge = bridgeRef.current;
        if (!bridge) return next;
        const url = bridge.controllerFor(tabId)?.element?.getURL?.() || tabs.find((entry) => entry.id === tabId)?.url || "";
        const old = bridge.controllerFor(tabId);
        if (old) {
          bridge.setController(tabId, null);
          controllerMapRef.current.delete(tabId);
          await old.release().catch(() => {});
        }
        const controller = newGuestController(tabId);
        controllerMapRef.current.set(tabId, controller);
        await mountGuest({ id: tabId, url }, controller);
        return next;
      }

      // Toggle mobile emulation for the active tab.
      async function toggleDeviceMode() {
        const tabId = activeTabId;
        if (!desktop || !bridgeRef.current || !tabId) return;
        const previous = deviceModeFor(tabId);
        await applyDeviceMode(tabId, { mobile: !previous.mobile });
      }

      function startWidthDrag(event, tabId) {
        const mode = deviceModeFor(tabId);
        if (!mode.mobile) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture?.(event.pointerId);
        dragStateRef.current = { tabId, startX: event.clientX, startWidth: mode.width };
        function onMove(moveEvent) {
          const drag = dragStateRef.current;
          if (!drag) return;
          // The handle sits on the frame's LEFT edge: dragging left widens.
          const width = Math.min(820, Math.max(300, drag.startWidth + (drag.startX - moveEvent.clientX)));
          const modes = new Map(deviceModesRef.current);
          modes.set(drag.tabId, { mobile: true, width });
          deviceModesRef.current = modes;
          setDeviceModes(modes);
        }
        function onUp() {
          dragStateRef.current = null;
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
        }
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }

      function installGuestListeners(controller, tabId, bridge) {
        const element = controller.element;
        const noteHistory = () => {
          const url = element.getURL && element.getURL();
          if (!url || url.startsWith("about:blank")) return;
          const log = bridge.history.get(tabId) ?? [];
          if (log[0] !== url) {
            log.unshift(url);
            if (log.length > 50) log.length = 50;
            bridge.history.set(tabId, log);
          }
        };
        const report = (extra) => bridge.reportEvent({
          kind: "tab-update", tabId,
          url: element.getURL && element.getURL(),
          title: element.getTitle && element.getTitle(),
          loading: element.isLoading && element.isLoading(),
          canGoBack: element.canGoBack && element.canGoBack(),
          canGoForward: element.canGoForward && element.canGoForward(),
          ...extra,
        });
        let loadingWatchdog = null;
        const stopLoadingWatchdog = () => {
          if (loadingWatchdog) { clearInterval(loadingWatchdog); loadingWatchdog = null; }
        };
        const startLoadingWatchdog = () => {
          stopLoadingWatchdog();
          const startedAt = Date.now();
          loadingWatchdog = setInterval(() => {
            if (controller.released) {
              stopLoadingWatchdog();
              return;
            }
            // did-stop-loading occasionally never fires on the webview (and
            // SPA in-page navigations never trigger it at all); poll the guest
            // and also hard-cap the indicator at 15 s so the bar cannot stick.
            if (!(element.isLoading && element.isLoading()) || Date.now() - startedAt > 15000) {
              stopLoadingWatchdog();
              report({ loading: false });
            }
          }, 500);
        };
        controller.addListener("dom-ready", () => {
          controller.domReady = true;
          // Capture page-side errors for the console tool on every navigation.
          element.executeJavaScript(CONSOLE_HOOK_SOURCE, false).catch(() => {});
          report({ navigated: true });
        });
        controller.addListener("did-navigate", () => { noteHistory(); stopLoadingWatchdog(); report({ navigated: true, loading: false }); });
        // SPA hash/history navigations complete here without any stop-loading
        // event; treat them as finished so the loading bar always clears.
        controller.addListener("did-navigate-in-page", (e) => { if (e.isMainFrame) { noteHistory(); stopLoadingWatchdog(); report({ navigated: true, loading: false }); } });
        controller.addListener("did-start-navigation", (e) => { if (e.isMainFrame) { report({ loading: true }); startLoadingWatchdog(); } });
        controller.addListener("did-stop-loading", () => {
          stopLoadingWatchdog();
          report({ loading: false });
        });
        controller.addListener("page-title-updated", () => report({}));
        controller.addListener("render-process-gone", () => report({ crashed: true }));
        controller.addListener("destroyed", () => report({ crashed: true }));
        controller.addListener("did-fail-load", (e) => { if (e.isMainFrame) report({ loading: false }); });
      }

      function activeController() {
        return activeTabId ? bridgeRef.current?.controllerFor(activeTabId) : null;
      }

      function applyZoom(delta) {
        const el = activeController()?.element;
        if (!el) return;
        const currentFactor = typeof el.getZoomFactor === "function" ? el.getZoomFactor() : 1;
        const next = delta === null ? 1 : Math.min(3, Math.max(0.25, Math.round((currentFactor + delta) * 100) / 100));
        if (typeof el.setZoomFactor === "function") el.setZoomFactor(next);
      }

      function applyResolution(tabId, res) {
        const next = new Map(resolutionsRef.current);
        if (res) next.set(tabId, res);
        else next.delete(tabId);
        resolutionsRef.current = next;
        setResolutions(next);
      }

      function zoomLabel() {
        const el = activeController()?.element;
        return el && typeof el.getZoomFactor === "function" ? Math.round(el.getZoomFactor() * 100) + "%" : "100%";
      }

      function submitAddress(event) {
        event.preventDefault();
        const parsed = parseAddress(draft, window.location.origin);
        if (!parsed.ok) { setError(t(`error.${parsed.reason}`) || parsed.reason); return; }
        setError(null);
        setEditing(false);
        const controller = activeController();
        if (controller?.element) {
          controller.element.loadURL(parsed.url).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        } else {
          // No open tab (or its guest is not mounted yet): ask the Host to
          // create one and navigate, so the address bar works stand-alone.
          bridgeRef.current?.post("/event", { kind: "open", url: parsed.url }).catch(() => {});
        }
        setDraft(parsed.url);
      }

      const [editing, setEditing] = React.useState(false);
      // Standard-browser behavior: the address bar mirrors the active tab's
      // URL in real time, except while the user is editing it.
      React.useEffect(() => {
        if (!editing) setDraft(current?.url ?? "");
      }, [editing, current?.url, activeTabId]);


      function menuItem(label, onClick, disabled) {
        return h("button", { type: "button", className: "eb-menu-item", role: "menuitem", disabled: disabled || false, onClick }, label);
      }
      function menuCheck(label, checked, onClick) {
        return h("button", { type: "button", className: "eb-menu-item", role: "menuitemcheckbox", "aria-checked": checked ? "true" : "false", onClick },
          h("span", { className: "eb-menu-check" }, checked ? IconCheck() : null), label);
      }

      return h(PanelErrorBoundary, null,
        h("div", { className: "eb-root", ref: (node) => { registryEntryRef.current.node = node; } },
        h("div", { className: "eb-tabstrip" },
          tabs.map((entry) => h("button", { key: entry.id, type: "button", className: "eb-tab", "data-active": entry.id === activeTabId ? "true" : "false", title: entry.url || entry.title, onClick: () => bridgeRef.current?.post("/event", { kind: "switch", tabId: entry.id }).catch(() => {}) },
            h("span", { className: "eb-tabTitle" }, entry.title || entry.url || t("newTab")),
            h("span", { className: "eb-tabClose", role: "button", "aria-label": t("closeTab"), onClick: (e) => { e.stopPropagation(); bridgeRef.current?.post("/event", { kind: "close", tabId: entry.id }).catch(() => {}); } }, "×"))),
          h("button", { type: "button", className: "eb-tool", style: { width: 24, height: 24, margin: "2px 0" }, "aria-label": t("newTab"), title: t("newTab"), onClick: () => bridgeRef.current?.post("/event", { kind: "new" }).catch(() => {}) }, IconPlus())),
        h("div", { className: "eb-toolbar" },
          h("button", { type: "button", className: "eb-tool", "aria-label": t("back"), title: t("back"), disabled: !current?.canGoBack, onClick: () => activeController()?.element?.goBack() }, IconBack()),
          h("button", { type: "button", className: "eb-tool", "aria-label": t("forward"), title: t("forward"), disabled: !current?.canGoForward, onClick: () => activeController()?.element?.goForward() }, IconForward()),
          h("button", { type: "button", className: "eb-tool", "aria-label": t("reload"), title: t("reload"), disabled: !current, onClick: () => activeController()?.element?.reload() }, IconRefresh()),
          h("form", { className: "eb-addressBox", onSubmit: submitAddress },
            h("input", { className: "eb-address", value: draft, placeholder: t("address.placeholder"), "aria-label": t("address.placeholder"), spellCheck: false, onFocus: () => setEditing(true), onBlur: () => setEditing(false), onChange: (e) => setDraft(e.currentTarget.value) })),
          h("button", { type: "button", className: "eb-tool", style: deviceModeFor(activeTabId)?.mobile ? { color: "var(--dsh-alias-state-business-primary)" } : undefined, "aria-label": t("deviceMode"), title: t("deviceMode"), disabled: !current, onClick: () => toggleDeviceMode() }, IconPhone()),
          h("button", { type: "button", className: "eb-tool", "aria-label": t("menu.label"), title: t("menu.label"), onClick: () => setMenuOpen((open) => !open) }, IconDots())),
        menuOpen ? h("div", { className: "eb-menu-backdrop", onClick: () => setMenuOpen(false) }) : null,
        menuOpen ? h("div", { className: "eb-menu", role: "menu" },
          menuItem(t("menu.newTab"), () => { setMenuOpen(false); bridgeRef.current?.post("/event", { kind: "new" }).catch(() => {}); }),
          menuItem(`${t("menu.zoomIn")} · ${zoomLabel()}`, () => { applyZoom(0.1); }),
          menuItem(t("menu.zoomOut"), () => { applyZoom(-0.1); }),
          menuItem(t("menu.zoomReset"), () => { applyZoom(null); }),
          h("div", { className: "eb-menu-sep" }),
          menuItem(t("menu.resolution"), () => { setMenuOpen(false); setResolutionOpen(true); }),
          h("div", { className: "eb-menu-sep" }),
          menuItem(t("menu.copyLink"), () => { setMenuOpen(false); if (current?.url) navigator.clipboard?.writeText(current.url).catch(() => {}); }),
          menuItem(t("external"), () => { setMenuOpen(false); if (current?.url) window.open(current.url, "_blank", "noopener,noreferrer"); }, !current?.url)) : null,
        resolutionOpen ? h("div", { className: "eb-resbar" },
          h("span", null, t("resolution.label")),
          h("input", { type: "number", min: 200, max: 7680, value: resDraft.w, onChange: (e) => { const v = Number(e.currentTarget.value); setResDraft((d) => ({ ...d, w: v })); } }),
          h("span", null, "×"),
          h("input", { type: "number", min: 200, max: 7680, value: resDraft.h, onChange: (e) => { const v = Number(e.currentTarget.value); setResDraft((d) => ({ ...d, h: v })); } }),
          h("button", { type: "button", onClick: () => { if (activeTabId && resDraft.w >= 200 && resDraft.h >= 200) applyResolution(activeTabId, { w: Math.round(resDraft.w), h: Math.round(resDraft.h) }); } }, t("resolution.apply")),
          // The preset ALWAYS updates the draft; only the application to a
          // live tab is gated on having an active tab.
          h("select", { className: "eb-resselect", value: "", onChange: (e) => { const label = e.currentTarget.value; const preset = RESOLUTION_PRESETS.find((p) => p.label === label); if (preset) setResDraft({ w: preset.w, h: preset.h }); if (preset && activeTabId) { applyResolution(activeTabId, { w: preset.w, h: preset.h }); } e.currentTarget.value = ""; } },
            h("option", { value: "" }, t("resolution.presets")),
            RESOLUTION_PRESETS.map((preset) => h("option", { key: preset.label, value: preset.label }, preset.label))),
          h("button", { type: "button", onClick: () => { if (activeTabId) applyResolution(activeTabId, null); } }, t("resolution.clear")),
          h("button", { type: "button", "aria-label": "Close", onClick: () => setResolutionOpen(false) }, "×")) : null,
        error ? h("div", { className: "eb-warning", role: "alert" }, error) : null,
        current?.loading ? h("div", { className: "eb-loading", role: "progressbar" }, h("span")) : null,
        h("div", { className: "eb-content" },
          h("div", { className: "eb-viewport", ref: viewportRef }, tabs.map((entry) => {
            const mode = deviceModeFor(entry.id);
            const res = resolutions.get(entry.id);
            const scale = res ? (frameScales[entry.id] ?? 1) : 1;
            const style = res
              ? { width: res.w + "px", height: res.h + "px", transform: `scale(${scale})` }
              : mode.mobile ? { width: mode.width + "px" } : undefined;
            return h("div", {
              key: entry.id,
              className: "eb-guest-mount",
              hidden: entry.id !== activeTabId,
              "data-mobile": mode.mobile ? "true" : "false",
              style,
              ref: (node) => {
                if (node) mountNodesRef.current.set(entry.id, node);
                else mountNodesRef.current.delete(entry.id);
              },
            }, mode.mobile && !res && entry.id === activeTabId
              ? h("div", { className: "eb-width-handle", title: t("deviceWidth"), onPointerDown: (event) => startWidthDrag(event, entry.id) })
              : null);
          })),
          !desktop ? h("div", { className: "eb-placeholder" }, t("disconnected")) : null,
          desktop && tabs.length === 0 ? h("div", { className: "eb-placeholder" }, t("start")) : null)));
    }

    function BrowserTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } }, IconGlobe(), tab.title || "Browser");
    }

    // Guide-entry glyph: the sidebar guide renders `entry.icon` as a React
    // component receiving a `size` prop; without one the entry shows a blank.
    function GuideIcon({ size } = {}) {
      // Slightly smaller than the slot and colored, matching the style of
      // the built-in browser's guide entry.
      const px = Math.round((size ?? 22) * 0.8);
      return h("svg", { width: px, height: px, viewBox: "0 0 24 24", "aria-hidden": true },
        h("defs", null,
          h("linearGradient", { id: "dshBrowserGlobe", x1: 0, y1: 0, x2: 1, y2: 1 },
            h("stop", { offset: 0, stopColor: "#3b9df2" }),
            h("stop", { offset: 1, stopColor: "#1f6fd6" }))),
        h("circle", { cx: 12, cy: 12, r: 9, fill: "url(#dshBrowserGlobe)" }),
        h("g", { fill: "none", stroke: "#fff", strokeWidth: 1.1, opacity: 0.9 },
          h("ellipse", { cx: 12, cy: 12, rx: 4, ry: 9 }),
          h("path", { d: "M3.5 12h17" }),
          h("path", { d: "M5 7.5c4.5 2 9.5 2 14 0M5 16.5c4.5-2 9.5-2 14 0" })));
    }

    // Invisible session-scoped marker: mounts while its session is displayed
    // and unmounts when it is not (session-scoped slot semantics). It exists
    // for EVERY session — even ones without a browser panel — which is what
    // finally lets the auto-present poller know the on-screen session id.
    function SessionVisibilityMarker({ sessionId } = {}) {
      React.useEffect(() => {
        visibleMarkerSessionId = typeof sessionId === "string" ? sessionId : null;
        // Beacon so the Host log can confirm the marker is alive and which
        // session it reports (fire-and-forget, never blocks the UI).
        try {
          if (typeof sessionId === "string") fetch(`${location.origin}${API_PATH}/marker?sid=${encodeURIComponent(sessionId.slice(0, 8))}`, { cache: "no-store" }).catch(() => {});
        } catch { /* logging only */ }
        return () => { visibleMarkerSessionId = null; };
      }, [sessionId]);
      return null;
    }

    /* ------------------------------------------------------------------
     * Registration
     * ---------------------------------------------------------------- */
    const inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs", "layout", "uiWorkspace"];

    function apply(ctx) {
      ensureCss();
      const namespace = "dshBrowser";
      const t = ctx.locale.bind(namespace);

      // Auto-present: when an Agent tool needs the panel, the Host reports
      // which sessions are waiting; this module-level poller opens it in the
      // RIGHT session. Direct open when that session is on screen; otherwise
      // a guarded session switch: the shell's openTab only reaches the
      // visible session, so we briefly switch over, create the panel, WAIT
      // until its body has mounted and had time to register and send its
      // first poll (which unblocks the waiting tool call), then switch back.
      // Panels that exist but are hidden (keepMounted) connect by themselves.
      ctx.effect(() => {
        let cooldownUntil = 0;
        let lastDanceAt = 0;
        const openBrowserTab = async () => {
          // New-tab form is `${kind}:new` (how the sidebar's own guide opens
          // a fresh tab); a bare kind is looked up as an EXISTING tab by
          // contentId/kind and focuses it (the sidebar matches either).
          try { await ctx.sidebarRight?.openTab?.("dsh-browser:new"); }
          catch {
            try { await ctx.sidebarRight?.openTab?.(PLUGIN_ID); } catch { /* shell API drift */ }
          }
        };
        // A tab created while the pane is inert may never mount its body;
        // focusing the kind re-activates the tab and forces the pane to
        // render it (the same path a manual click on the tab uses).
        const focusBrowserTab = async () => {
          try { await ctx.sidebarRight?.openTab?.("dsh-browser"); }
          catch { /* best-effort */ }
        };
        const switchSession = (target) => {
          if (!target) return false;
          // Strict check inside one try: the ctx.uiWorkspace GETTER itself
          // throws when the service is unavailable, which would otherwise
          // kill the whole poller tick (observed as poll-error beacons).
          try {
            const ws = ctx.uiWorkspace;
            if (!ws || typeof ws.openSession !== "function") return false;
            ws.openSession(target);
            return true;
          } catch { return false; }
        };
        // The right sidebar shell (DSH's own pane) renders asynchronously
        // after openRightbar. Creating a tab in the SAME React commit used to
        // leave the whole pane blank for seconds (the two reconciles blocked
        // each other). Wait until the pane shell has actually appeared, so
        // the shell paints first and the tab content follows in a later
        // commit. Also doubles as our timing probe for the blank window.
        const waitForPane = (timeoutMs = 1500) => {
          const start = Date.now();
          const check = () => {
            const c = document.querySelector("[data-sidebar-right-session]");
            return Boolean(c && !c.closest("[hidden]") && window.getComputedStyle(c).visibility !== "hidden");
          };
          return new Promise((resolve) => {
            if (check()) return resolve(Date.now() - start);
            const timer = setTimeout(() => { observer.disconnect(); resolve(-(Date.now() - start)); }, timeoutMs);
            const observer = new MutationObserver(() => {
              if (check()) { clearTimeout(timer); observer.disconnect(); resolve(Date.now() - start); }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class", "data-sidebar-right-open"] });
          });
        };
        const hasPanelFor = (sid) => [...panelRegistry].some((entry) => entry.sessionId === sid);
        // Diagnostic step beacon: each dance milestone reports itself through
        // the /marker log so the next debug read shows exactly where it stalls.
        const step = (name) => {
          try { fetch(`${location.origin}${API_PATH}/marker?sid=step:${encodeURIComponent(name)}`, { cache: "no-store" }).catch(() => {}); } catch { /* logging only */ }
        };
        const waitFor = async (fn, timeoutMs) => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (fn()) return true;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return fn();
        };
        // Adaptive polling: idle at 3 s, but once a panel is demanded the
        // cadence rises to 800 ms so the auto-open reacts quickly; the dance
        // path itself is the expensive part, not the detection.
        let pollTimer = null;
        const pollOnce = async () => {
          let sawDemand = false;
          try {
            if (Date.now() < cooldownUntil) { pollTimer = setTimeout(pollOnce, 1000); return; }
            const response = await fetch(`${location.origin}${API_PATH}/present`, { cache: "no-store" });
            if (!response.ok) { pollTimer = setTimeout(pollOnce, 3000); return; }
            const payload = await response.json().catch(() => null);
            if (!payload) { pollTimer = setTimeout(pollOnce, 3000); return; }
            const needed = (Array.isArray(payload.sessions) ? payload.sessions : (payload.open ? ["*"] : [])).filter((sid) => sid && sid !== "*");
            if (needed.length === 0) { step("poll:empty"); pollTimer = setTimeout(pollOnce, 3000); return; }
            sawDemand = true;
            const visible = currentVisibleSessionId();
            step(`poll:needed=${needed.map((s) => String(s).slice(0, 8)).join("+")}:visible=${String(visible).slice(0, 8)}`);
            for (const sid of needed) {
              if (hasPanelFor(sid)) continue;
              if (sid === visible) {
                // Expand FIRST: a tab created while the sidebar is collapsed
                // never mounts its body (the pane is inert), which silently
                // kills the whole auto-open flow. Then WAIT for the shell's
                // pane to appear before creating the tab, so the two React
                // commits do not stack into one long blank window.
                try { ctx.layout?.openRightbar?.(true, false); } catch { /* shell API drift */ }
                const paneMs = await waitForPane();
                step(`pane:${paneMs}ms`);
                const tOpen = performance.now();
                await openBrowserTab();
                step(`openTab:${Math.round(performance.now() - tOpen)}ms`);
                step("direct-opened-new");
                // A freshly created tab's body does NOT mount on its own — it
                // needs one focus activation (observed: a 3 s inert wait until
                // the old focus fallback fired). Focus IMMEDIATELY instead of
                // waiting out the full timeout first.
                const tFocus = performance.now();
                await focusBrowserTab();
                step(`direct-focused:${Math.round(performance.now() - tFocus)}ms`);
                const tMount = performance.now();
                await waitFor(() => hasPanelFor(sid), 2500);
                if (!hasPanelFor(sid)) {
                  await focusBrowserTab();
                  step("direct-refocused");
                  await waitFor(() => hasPanelFor(sid), 2000);
                }
                step(`mount-wait:${Math.round(performance.now() - tMount)}ms`);
                step(`direct-mounted:${hasPanelFor(sid)}`);
                continue;
              }
              // Needing session is not on screen: briefly switch over and
              // create the panel there, but only one dance at a time and not
              // too often — the user's view is borrowed, never taken.
              if (Date.now() - lastDanceAt < 15000) continue;
              lastDanceAt = Date.now();
              step(`dance-start:${String(sid).slice(0, 8)}:visible=${String(visible).slice(0, 8)}`);
              if (!switchSession(sid)) { step("dance-no-switch"); continue; }
              step("dance-switched");
              try {
                // Fast path: openSession is a synchronous store update; wait
                // for the switched session's pane shell before creating the
                // tab so the shell paints first (same split-commit rationale
                // as the direct branch).
                const paneMs = await waitForPane(2500);
                step(`dance-pane:${paneMs}ms`);
                try { ctx.layout?.openRightbar?.(true, false); } catch { /* shell API drift */ }
                const tOpen = performance.now();
                await openBrowserTab();
                step(`dance-openTab:${Math.round(performance.now() - tOpen)}ms`);
                step("dance-opened-new");
                // Same inert-body rule as the direct branch: focus right away.
                await focusBrowserTab();
                step("dance-focused");
                const tMount = performance.now();
                await waitFor(() => hasPanelFor(sid), 1200);
                step(`dance-mount-wait:${Math.round(performance.now() - tMount)}ms`);
                if (!hasPanelFor(sid)) {
                  // Slow path: the session swap had not committed yet; wait
                  // for the marker, then create (and focus if still inert).
                  await waitFor(() => currentVisibleSessionId() === sid, 2500);
                  step(`dance-marker:${currentVisibleSessionId() === sid}`);
                  await openBrowserTab();
                  await waitFor(() => hasPanelFor(sid), 2500);
                  if (!hasPanelFor(sid)) {
                    await focusBrowserTab();
                    step("dance-focused");
                    await waitFor(() => hasPanelFor(sid), 2000);
                  }
                }
                step(`dance-mounted:${hasPanelFor(sid)}`);
                // Wait until the client has REGISTERED AND POLLED: that first
                // poll is what unblocks the waiting tool call on the Host, so
                // the task is already running before we hand the view back.
                try {
                  const startReady = Date.now();
                  while (Date.now() - startReady < 12000) {
                    const r = await fetch(`${location.origin}${API_PATH}/ready?sid=${encodeURIComponent(sid)}`, { cache: "no-store" }).catch(() => null);
                    if (r && (await r.json().catch(() => null))?.ready) break;
                    await new Promise((resolve) => setTimeout(resolve, 200));
                  }
                } catch { /* best-effort */ }
                await new Promise((resolve) => setTimeout(resolve, 300));
              } finally {
                if (visible) switchSession(visible);
              }
            }
            cooldownUntil = Date.now() + 15000;
          } catch (error) { step("poll-error:" + String(error && error.message ? error.message : error).slice(0, 60)); }
          // Idle at 1 s (a tool call is noticed promptly), rising to 800 ms
          // while a panel is actively being opened.
          pollTimer = setTimeout(pollOnce, sawDemand ? 800 : 1000);
        };
        pollTimer = setTimeout(pollOnce, 800);
        return () => clearTimeout(pollTimer);
      }, `${PLUGIN_ID}:auto-present`);

      // Each registration is isolated so one failing registration (for example
      // a duplicate on a module re-apply) cannot blank the whole panel.
      const safeEffect = (label, setup) => {
        ctx.effect(() => {
          try {
            return setup();
          } catch (error) {
            console.error(`[${PLUGIN_ID}] ${label} failed:`, error);
            return undefined;
          }
        }, `${PLUGIN_ID}:${label}`);
      };

      safeEffect("locale", () => ctx.locale.register(namespace, {
        en: {
          "type.label": "DSH Browser", "guide.title": "DSH Browser",
          "guide.description": "Browse with this plugin's sidebar panel and Agent tools",
          "address.placeholder": "Enter an HTTPS address", back: "Back", forward: "Forward", reload: "Reload",
          newTab: "New tab", closeTab: "Close tab", external: "Open in system browser",
          deviceMode: "Toggle mobile mode", deviceWidth: "Drag to resize the mobile viewport",
          "menu.label": "Browser options", "menu.newTab": "New tab", "menu.zoomIn": "Zoom in", "menu.zoomOut": "Zoom out", "menu.zoomReset": "Reset zoom (100%)",
          "menu.copyLink": "Copy link", "menu.resolution": "Resolution…",
          "resolution.label": "Viewport", "resolution.apply": "Apply", "resolution.clear": "Clear", "resolution.presets": "Presets",
          start: "Enter an HTTPS address to start browsing", loading: "Opening…",
          disconnected: "The DSH Browser requires the DSH Desktop runtime.",
          "error.empty": "Enter an address.", "error.invalid": "That address is invalid or too long.",
          "error.protocol": "Only http: and https: addresses are allowed.", "error.credentials": "Addresses cannot contain a username or password.",
          "error.application-origin": "Cannot open the DSH application inside the browser.",
          sandboxWarning: "Browser storage and isolation are runtime-dependent and have not been verified. Page content may be shared with the Agent."
        },
        zh: {
          "type.label": "Agent 浏览器", "guide.title": "Agent 浏览器",
          "guide.description": "使用插件的侧栏面板和 Agent 工具浏览网页",
          "address.placeholder": "输入 HTTPS 地址", back: "后退", forward: "前进", reload: "刷新",
          newTab: "新建标签页", closeTab: "关闭标签页", external: "在系统浏览器中打开",
          deviceMode: "切换手机模式", deviceWidth: "拖拽调整手机视口宽度",
          "menu.label": "浏览器选项", "menu.newTab": "新建标签页", "menu.zoomIn": "放大", "menu.zoomOut": "缩小", "menu.zoomReset": "重置缩放（100%）",
          "menu.copyLink": "复制链接", "menu.resolution": "分辨率设置…",
          "resolution.label": "视口", "resolution.apply": "应用", "resolution.clear": "清除", "resolution.presets": "预设分辨率",
          start: "输入 HTTPS 地址开始浏览", loading: "正在打开…",
          disconnected: "Agent 浏览器需要 DSH Desktop 运行时。",
          "error.empty": "请输入地址。", "error.invalid": "地址无效或过长。",
          "error.protocol": "仅允许 http: 与 https: 地址。", "error.credentials": "地址不能包含用户名或密码。",
          "error.application-origin": "不能在嵌入浏览器中打开 DSH 应用自身。",
          sandboxWarning: "浏览器存储与隔离行为取决于运行时，尚未验证。页面内容可能会发送给 Agent。"
        }
      }));

      // keepMounted keeps the panel body (and its webviews, bridge, and agent
      // session) alive across tab switches, session switches, collapse and
      // floating — the same flag the built-in browser tab type declares.
      safeEffect("type", () => ctx.sidebarRightTabs.register({
        id: PLUGIN_ID, kind: "dsh-browser", multiple: true, priority: "plugin", keepMounted: true,
        title: () => t("type.label"),
        guide: [{ id: "new", order: 35, title: () => t("guide.title"), description: () => t("guide.description"), icon: GuideIcon }]
      }));
      // Register the invisible per-session marker through the lazy slot
      // injector (same pattern as the UI decoration template).
      safeEffect("marker", () => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock", id: "dsh-browser-visibility", order: 999,
      }, SessionVisibilityMarker)));

      safeEffect("body", () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab", key: PLUGIN_ID, locale: namespace
      }, BrowserBody)));

      safeEffect("title", () => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
        name: "sidebar.right.pane.tab.title", key: PLUGIN_ID, locale: namespace
      }, BrowserTitle)));
    }

    const module = { exports: {} };
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  }
});
