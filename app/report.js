// Reports of what went wrong, sent to the relay (relay/src/relay.js, POST /reports) where whoever runs this copy of the app
// reads them (relay/reports.mjs): so that someone it failed for need not copy an error out and send it on. Only where they
// have not said no (`reporting`: the tickbox when joining or starting a session, kept in this browser).
//
// What a report holds is what helps find what went wrong and nothing of anyone's work: what was being done and how it failed,
// this app's build, the browser, and what the page has seen go wrong lately (`seen`: requests that failed or were refused,
// by their address without its query; errors thrown and not caught; what the page's security policy blocked; the relay's
// sockets that closed). Not names, files, tokens, or a session's secret (an address is sent without what follows its #).
//
// Two ways in, one way out (`report`): what someone was doing when it failed, said where they are told (`report`: joining
// or starting a session); and what went wrong with nobody there to say so (`trouble`: errors thrown and not caught, the
// GPU's refusals and its being lost as the 3D view tells them, with what GPU it is, and a view that could not be made),
// each once a page and only so many.
//
// The watcher starts as this is first imported (main.js imports it before anything else), so it sees what fails while the
// page loads.

import { GITHUB_APP } from "./config.js";

const KEY = "fettled.reporting";
/** How many of each kind of thing seen are kept: the last so many. */
const KEPT = 40;
/** The longest any one thing said in a report is, and the most a report is (the relay takes no more: relay.js). */
const SAID_AT_MOST = 2000, REPORT_AT_MOST = 60 * 1024;
const started = Date.now();

/** What the page has seen go wrong lately, each kind the last `KEPT`, each `{ t }` ms since the page began. */
export const seen = { requests: [], errors: [], blocked: [], sockets: [], console: [], gpu: [] };
const note = (list, x) => { list.push({ t: Date.now() - started, ...x }); if (list.length > KEPT) list.shift(); };
const clip = (s) => { const t = String(s ?? ""); return t.length > SAID_AT_MOST ? `${t.slice(0, SAID_AT_MOST)}…` : t; };
/** An address as reported: its origin and path, not its query or what follows its # (a token, a session's secret). */
export function where(url) {
  try {
    const u = new URL(String(url), globalThis.location?.href);
    return u.protocol === "data:" || u.protocol === "blob:" ? `${u.protocol}…` : `${u.origin}${u.pathname}`;
  } catch (_) {
    return "?";
  }
}

// (Requests: each that failed to be made, or was answered with an error, kept. What answered well is not.)
const fetched = globalThis.fetch?.bind(globalThis);
if (fetched) {
  globalThis.fetch = async (input, init) => {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = where(isRequest ? input.url : input), method = init?.method ?? (isRequest ? input.method : "GET"), t0 = Date.now();
    try {
      const r = await fetched(input, init);
      if (!r.ok && r.type !== "opaque") note(seen.requests, { method, url, status: r.status, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      // (Stopped by the page itself, as when a view moves on: not something that went wrong.)
      if (e?.name !== "AbortError") note(seen.requests, { method, url, failed: clip(e?.message ?? e), ms: Date.now() - t0 });
      throw e;
    }
  };
}
// (Sockets: the relay's, as they close other than as the page asked.)
const Socket = globalThis.WebSocket;
if (Socket) {
  globalThis.WebSocket = class extends Socket {
    constructor(url, protocols) {
      super(url, protocols);
      const at = where(url), t0 = Date.now();
      this.addEventListener("error", () => note(seen.sockets, { url: at, error: true, ms: Date.now() - t0 }));
      this.addEventListener("close", (e) => { if (e.code !== 1000) note(seen.sockets, { url: at, code: e.code, reason: clip(e.reason), clean: e.wasClean, ms: Date.now() - t0 }); });
    }
  };
}
// (What the page says in its console as an error: a panic of the engine's or the view's is said there, before the
// "unreachable" it throws.)
const said = globalThis.console?.error;
if (said) {
  console.error = (...args) => {
    note(seen.console, { said: clip(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })())).join(" ")) });
    return said.apply(console, args);
  };
}
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    note(seen.errors, { message: clip(e.message), at: e.filename ? `${where(e.filename)}:${e.lineno}:${e.colno}` : undefined, stack: clip(e.error?.stack) });
    // (Not of this page's own: another's script says only "Script error.", and the browser's own notes on layout are not
    // errors of anyone's.)
    const ours = e.error && (!e.filename || where(e.filename).startsWith(globalThis.location?.origin ?? ""));
    if (ours && !/^ResizeObserver loop/.test(e.message)) trouble("uncaught", e.error, { at: `${where(e.filename)}:${e.lineno}:${e.colno}` });
  });
  window.addEventListener("unhandledrejection", (e) => {
    note(seen.errors, { message: clip(e.reason?.message ?? e.reason), stack: clip(e.reason?.stack), unhandled: true });
    // (Stopped by the page itself, as when a view moves on: not something that went wrong.)
    if (e.reason?.name !== "AbortError") trouble("unhandled", e.reason);
  });
  // (What the page's own security policy would not let it reach: a request that only says it failed.)
  document.addEventListener("securitypolicyviolation", (e) => note(seen.blocked, { blocked: where(e.blockedURI), directive: e.effectiveDirective }));
  // (What the GPU refused, or its being lost, as the 3D view tells it (fettled-view's `tell_gpu`): the GPU's message names
  // the shader or pipeline by its label; with what GPU it is, as the view and as the browser say.)
  window.addEventListener("fettled:gpu", (e) => {
    let d = {};
    try { d = JSON.parse(e.detail); } catch (_) { /* as nothing */ }
    gpuTrouble(d.kind, d.message, d.gpu, d.pipeline);
  });
}

/** What the GPU refused (`kind`: validation, out of memory, internal; or its being lost), by its `message`, which names the
 *  shader or pipeline by its label; `view`: what GPU the view says it draws through, where it is the view's; `pipeline`:
 *  where it was a pipeline the GPU could not make, which (its name and shader definitions) and what the GPU made of it
 *  with each of its shaders' probes on (`probes`: `{on, says, made, refused}`, Pangolino's pipeline/probes.rs). Kept with
 *  what is seen, and reported, unless it failed only because something before it did: the first says why. */
function gpuTrouble(kind, message, view, pipeline) {
  note(seen.gpu, { kind, message: clip(message), pipeline: pipeline?.name });
  if (/invalid due to a previous error/i.test(message ?? "")) return;
  trouble("gpu", { name: kind, message }, { ...(view ? { gpu: view } : {}), ...(pipeline ? { pipeline } : {}) });
}

// (The GPU's internal errors, at each device the page has, before wgpu has them: wgpu (30) knows only those of validation and
// of memory as it takes a device's errors, and panics on any other (backend/webgpu.rs, `Error::from_js`), so that what went
// wrong is lost and the view stops. A driver that cannot make a pipeline says so as one. Those are reported here, and not handed
// on; the rest are, as they were.)
const Device = globalThis.GPUDevice, Internal = globalThis.GPUInternalError;
const hook = Device && Object.getOwnPropertyDescriptor(Device.prototype, "onuncapturederror");
if (hook?.set && Internal) {
  Object.defineProperty(Device.prototype, "onuncapturederror", {
    ...hook,
    set(fn) {
      hook.set.call(this, typeof fn !== "function" ? fn : function (e) {
        if (e?.error instanceof Internal) {
          console.error(`GPU internal: ${e.error.message}`);
          return gpuTrouble("internal", e.error.message);
        }
        return fn.call(this, e);
      });
    },
  });
}

let gpuSaid = null;
/** What the browser says of its GPU (WebGPU's adapter: who made it, its architecture, what it offers and its limits), as it
 *  would give the 3D view: asked once. */
function browserGpu() {
  gpuSaid ??= (async () => {
    try {
      const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
      if (!a) return null;
      const i = a.info ?? {}, limits = {};
      for (const k in a.limits) limits[k] = a.limits[k];
      return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, fallback: i.isFallbackAdapter ?? a.isFallbackAdapter, features: [...a.features].sort(), limits, format: navigator.gpu.getPreferredCanvasFormat?.() };
    } catch (err) {
      return { failed: clip(err?.message ?? err) };
    }
  })();
  return gpuSaid;
}

/** The most reports one page sends by itself (`trouble`), and those it has sent, by what they were of and their message
 *  (and, of a pipeline the GPU could not make, which variant: a driver says the same of each): each once, so that what
 *  fails every frame is said once. */
const TROUBLES_AT_MOST = 8;
const troubled = new Set();
const listeners = new Set();
/** Calls `fn({ what, message, id })` as each thing that went wrong is reported by itself (`trouble`): `id` the report's, or
 *  null where none was sent. Returns what stops that. */
export function onTrouble(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** What went wrong with nobody there to say so (thrown and not caught, the GPU's refusals, a view that could not be made):
 *  reported as `report` does, but each thing once a page and at most `TROUBLES_AT_MOST` of them; and told to whoever
 *  listens (`onTrouble`). The one way such things are reported: the report's id, or null. Never throws. */
export async function trouble(what, e, extra = {}) {
  const message = clip(e?.message ?? e);
  const of = extra.pipeline ? `\n${extra.pipeline.name}\n${JSON.stringify(extra.pipeline.defs)}` : "";
  const key = `${what}\n${message.slice(0, 300)}${of}`;
  if (troubled.has(key) || troubled.size >= TROUBLES_AT_MOST) return null;
  troubled.add(key);
  const id = await report(what, e, extra);
  for (const fn of listeners) { try { fn({ what, message, id }); } catch (_) { /* theirs */ } }
  return id;
}

/** Whether what goes wrong here may be reported: unless this browser's person has said no (the tickbox, shown when they join
 *  or start a session, ticked unless they untick it). */
export function reporting() {
  try {
    return localStorage.getItem(KEY) !== "no";
  } catch (_) {
    return false;
  }
}
/** The tickbox that says whether what goes wrong here may be reported (`reporting`), as HTML: `[data-a=report]`, wherever a
 *  person is asked who they are (the welcome card, account.js; the join and start dialog, session/enter.js), said the same
 *  in each. */
export function reportingBox() {
  return `<label class="reporting"><input type="checkbox" data-a="report"${reporting() ? " checked" : ""}><span>${REPORTING.label} <span class="muted">(${REPORTING.what})</span></span></label>`;
}
/** What the choice is said as, wherever it is offered (`reportingBox`; the account menu, account.js): what it is, and what
 *  a report holds. */
export const REPORTING = { label: "Automatically report errors", what: "what failed, this app's version, your browser and its GPU, and the requests that failed: never your name, your files or your links" };
export function setReporting(yes) {
  try {
    localStorage.setItem(KEY, yes ? "yes" : "no");
  } catch (_) { /* not kept: asked again next time */ }
}

/** What a request that only says it failed (the browser's "Failed to fetch") was of: the last one seen to fail, in words. */
export function unreached() {
  const r = [...seen.requests].reverse().find((x) => x.failed);
  if (!r) return null;
  const blocked = seen.blocked.some((b) => b.blocked !== "?" && r.url.startsWith(b.blocked));
  let host = r.url;
  try { host = new URL(r.url).host; } catch (_) { /* as it was */ }
  return `${host} could not be reached${blocked ? " (this page's security policy blocked it)" : ""}`;
}

let scripts = null;
/** Which build of the page's scripts this is (`{ commit, date, changed }`), as the server said it when it served them
 *  (app/js-build.js, made by fettled as it is asked for: none where another server served them, `{}` then). The engine
 *  says its own: the two are built apart (the engine by web/build.sh) and kept apart by a browser. */
export function scriptsBuild() {
  scripts ??= import(new URL("./js-build.js", import.meta.url).href).then((m) => m.default ?? {}, () => ({}));
  return scripts;
}

let build = null;
/** This app's build: its engine's, as web/build.sh said it beside it (pkg/build.json: read without the engine, which may be
 *  what failed), and its scripts' (`js`), as the server said it served them (app/js-build.js). */
function buildOf() {
  build ??= Promise.all([
    fetched?.(new URL("../pkg/build.json", import.meta.url), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) ?? null,
    scriptsBuild(),
  ]).then(([engine, js]) => (engine || js.commit ? { ...engine, js } : null));
  return build;
}

/** What is sent with a report, besides what went wrong: where, this build, the browser and its GPU, and what the page has
 *  seen. */
export async function context() {
  const nav = globalThis.navigator ?? {};
  return {
    page: where(globalThis.location?.href),
    query: Object.fromEntries([...new URLSearchParams(globalThis.location?.search ?? "")].filter(([k]) => ["in", "workspace", "part", "project"].includes(k))),
    build: await buildOf(),
    browser: { agent: nav.userAgent, language: nav.language, online: nav.onLine, connection: nav.connection?.effectiveType, cores: nav.hardwareConcurrency, memory: nav.deviceMemory },
    screen: globalThis.screen ? { width: screen.width, height: screen.height, ratio: globalThis.devicePixelRatio } : undefined,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gpu: await browserGpu(),
    since: Date.now() - started,
    seen,
  };
}

/** Reports what went wrong (`what`: what was being done, as `join`; `e`: the error; `extra`: anything else that says what of),
 *  where it may be: the report's id, or null where none was sent. Never throws. */
export async function report(what, e, extra = {}) {
  if (!reporting() || !fetched) return null;
  try {
    const said = { what, message: clip(e?.message ?? e), name: e?.name, stack: clip(e?.stack), extra, context: await context() };
    let body = JSON.stringify(said);
    if (body.length > REPORT_AT_MOST) body = JSON.stringify({ ...said, stack: undefined, context: { ...said.context, seen: undefined }, cut: true });
    const r = await fetched(`${GITHUB_APP.broker}/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return r.ok ? ((await r.json()).id ?? null) : null;
  } catch (_) {
    return null;
  }
}
