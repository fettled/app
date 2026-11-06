// The workspace of the project that is open: what has been put in its scene (slabs, polylines,
// views kept, rooms, planes), who is in it, what they have raised, and, where the project has
// a scan, the scan. The app works in it the same way wherever it is kept:
//
//   state               what there is, as last said; `onState(f)` hears of every change
//   call(tool, args)    does something in it (the tools are the ones an agent has): { text, images, error }
//   can(what)           whether this workspace has: "scan" (points: to draw, pick, select, fit to, and
//                       what they say of each member), "rays" (where each point was seen from),
//                       "shared" (other people and agents: proposals, chat, readings),
//                       "issues" (raising and working issues: those of a service, or of GitHub, where the project is on it),
//                       "people" (others in it, or in a session on it: their badges, and chat)
//
// It is kept by one of two backends, each of the shape below:
//
//   served   by `fettled serve`, of a project that is a git repository of its own: one for every browser and agent, in
//            the project's git repository, with whatever needs the scan's points worked out there;
//   local    in the project's own files, wherever those are (store.js): the model's aids, in its generated
//            files (docs/layers.md), as a served one keeps them. This page's alone.
//
// A service keeps one for each project that can have one there, opened as it is asked for; any other project has a local one.

import { pathIn } from "./ids.js";
import { model, storage } from "./project.js";
import { git } from "./git.js";
import { GitHubIssues } from "./github-issues.js";
import { proposing } from "./work.js";

// Who this browser is, in a workspace others are in: made once, and kept (as it is: not as JSON, as it always was).
const ID_KEY = "fettled.who", NAME_KEY = "fettled.session.name";
function myId() {
  const fresh = () => "p-" + Math.random().toString(36).slice(2, 10);
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) localStorage.setItem(ID_KEY, (id = fresh()));
    return id;
  } catch (_) {
    return fresh();
  }
}

/** A cloud as the service sends it (`fettled_scan::cloud`). */
function parseCloud(buf) {
  const n = new DataView(buf).getUint32(0, true);
  return {
    count: n,
    xyz: new Float32Array(buf, 4, 3 * n),
    intensity: new Uint8Array(buf, 4 + 12 * n, n),
    normal: new Int8Array(buf, 4 + 13 * n, 3 * n),
    // (A slab's points also say how much they are to be believed.)
    confidence: buf.byteLength >= 4 + 17 * n ? new Uint8Array(buf, 4 + 16 * n, n) : null,
  };
}

/** What every workspace's state has, whoever keeps it: nothing in it, till said otherwise. */
export const EMPTY = { loading: null, model: {}, scan: null, cloud: 0, placement: null, participants: [], issues: [], chat: [], views: [], rooms: [], surfaces: [], selections: [], slabs: [], polylines: [], shortcuts: [], tally: null };

/** What a scan's points answer, where no project is open. */
const NONE_OPEN = {
  evidence: async () => ({ parts: {} }),
  cloud: async () => null,
  slabPoints: async () => null,
  free: async () => null,
  selectionCloud: async () => null,
  selectionRays: async () => [],
  pick: async () => ({ hit: null }),
};

/** Free space as it is drawn (`fettled_scan::drawn`): w, h and the greatest count, then a byte a cell. */
function parseFree(buf) {
  const d = new DataView(buf);
  return { w: d.getUint32(0, true), h: d.getUint32(4, true), max: d.getUint32(8, true), data: new Uint8Array(buf, 12) };
}

const failed = (error) => ({ error: String(error?.message ?? error), text: "", images: [] });
const boxQuery = (box) => ["c", "u", "v", "n", "h"].map((k) => `${k}=${box[k].join(",")}`).join("&");

// ----- served: one workspace for everyone, kept by the service --------------------------------

function served(id, said, entry, room) {
  // (Every request says which project it is of, and which session: the service keeps a workspace for each that is asked for.)
  const of = (path) => `${path}${path.includes("?") ? "&" : "?"}part=${encodeURIComponent(entry)}${room ? `&room=${room}` : ""}`;
  const get = (path) => fetch(of(path), { cache: "no-cache" });
  const post = (path, body) => fetch(of(path), { method: "POST", body: JSON.stringify(body) });
  const cloud = async (path) => { const r = await get(path); return r.ok ? parseCloud(await r.arrayBuffer()) : null; };
  return {
    shared: true,
    start() {
      // (Open only while the page is: one gone from (to another project, say) may be kept by the browser to come back to, and a stream
      // it kept open would hold one of the six connections a browser makes to a host. Six of them, and the next page opened there has
      // none to load by: it says "loading…" for good. Gone from, it is closed; come back to, opened again, and the state said again.)
      let events = null;
      const open = () => {
        events = new EventSource(of(`api/events?who=${encodeURIComponent(id)}`));
        events.addEventListener("state", (e) => said({ ...EMPTY, ...JSON.parse(e.data) }, true));
        events.onerror = () => said(null, false);
      };
      addEventListener("pagehide", () => { events?.close(); events = null; });
      addEventListener("pageshow", (e) => { if (e.persisted && !events) open(); });
      open();
    },
    async call(tool, args) {
      try {
        const j = await (await post("api/call", { who: id, name: workspace.nameOf?.(), tool, args })).json();
        if (j.error) return failed(j.error);
        return {
          text: j.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
          images: j.content.filter((c) => c.type === "image").map((c) => `data:${c.mimeType};base64,${c.data}`),
        };
      } catch (e) {
        return failed(e);
      }
    },
    evidence: async () => (await get("api/evidence")).json(),
    diff: async (commit) => (await get(`api/diff?proposal=${encodeURIComponent(commit)}`)).json(),
    cloud: (k = 0) => cloud(`api/cloud?scan=${k}`),
    slabPoints: (box, max) => cloud(`api/slab?${boxQuery(box)}${max ? `&max=${max}` : ""}`),
    async free(box, w, h) {
      const r = await get(`api/free?${boxQuery(box)}&w=${w}&ht=${h}`);
      return r.ok ? parseFree(await r.arrayBuffer()) : null;
    },
    selectionCloud: (sel) => cloud(`api/selection?id=${encodeURIComponent(sel)}`),
    async selectionRays(sel) {
      const r = await get(`api/rays?id=${encodeURIComponent(sel)}`);
      return r.ok ? (await r.json()).rays ?? [] : [];
    },
    pick: async (origin, dir, z, slab, pixel) => (await post("api/pick", { origin, dir, z, slab, pixel })).json(),
  };
}

// ----- local: kept in the project's own files, for this page ---------------------------------

// The model's scene, in the engine's worker: fettled-scan's, the same tools a host's workspace has (docs/agents-in-sessions.md, step 7),
// of the project's files as this page has them. What a tool makes is an aid of the model (docs/layers.md), kept in its files.

/** A tool's answer, as the workspace says one: `{ text, images, error }`. */
function toldOf(r) {
  if (r.error) return failed(r.error);
  const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) return failed(text.replace(/^error: /, ""));
  return { text, images: (r.content ?? []).filter((c) => c.type === "image").map((c) => `data:${c.mimeType};base64,${c.data}`) };
}

function local(id, said, entry) {
  let doc = {};
  // (On GitHub, its issues are GitHub's.)
  const repo = storage.store?.base?.git, issues = repo?.issues ? new GitHubIssues({ git: repo, work: storage.store, tool: git, root: pathIn(entry), said: () => say(), viewUrl: (view) => workspace.viewUrl(view) }) : null;
  if (issues) proposing.said = () => issues.load().catch(() => {});
  /** What the scene is told of the page: who this person is called, and whether others make things here at the same moment. */
  const page = () => ({ names: { [id]: workspace.myName() ?? "you" }, shared: storage.sharedWithOthers(), budget: workspace.scanBudget });
  const say = () => said({ ...EMPTY, ...doc, ...(issues ? { issues: issues.list, workspace: { model: pathIn(entry) } } : {}), participants: [{ id, name: "you", kind: "person", colour: "#5b8def", presence: "here" }] }, true);
  // (The scene, as the model is built: again whenever it is; its scans read where they are kept, by their ranges.)
  const load = async () => { await model.sceneScans(page()); doc = (await model.sceneState(page())) ?? {}; say(); readOn(); };
  // Its scans read on, a slice at a time, so that what else is asked of the engine is answered between slices; said again after each
  // pass, which the view draws as it is read. One reader at a time: a load meanwhile is heard by it.
  let reading = false;
  async function readOn() {
    if (reading) return;
    reading = true;
    try {
      for (let passes = -1; ;) {
        const p = await model.sceneRead(page());
        if (!p) break;
        if (p.passes !== passes || p.complete) {
          passes = p.passes;
          doc = (await model.sceneState(page())) ?? {};
          say();
        }
        if (p.complete || p.failed) break;
      }
    } finally {
      reading = false;
    }
  }
  /** What is drawn of the scan, as the scene draws it (`fettled_scan::drawn`). */
  const draw = (what, args) => model.sceneDraw(what, args, page());
  const points = async (what, args) => { const b = await draw(what, args); return b ? parseCloud(b) : null; };
  model.onChange(load);
  return {
    shared: false,
    issues: !!issues,
    start() { issues?.start(); return load(); },
    async call(tool, args) {
      try {
        if (tool === "issues" && issues) return await issues.call(args);
        if (tool === "proposal" && issues) return await issues.proposal(args);
        // (A scan's tools read it where it is kept: given to the engine before it is loaded.)
        await model.sceneScans(page());
        const r = await model.sceneCall(id, tool, args, page());
        await load();
        return toldOf(r);
      } catch (e) {
        return failed(e);
      }
    },
    diff: async (commit) => (issues ? issues.diff(commit) : { error: "Proposals are said in the issues of a host, or of GitHub." }),
    /** A tool call by an agent this page is the tool host of (session/enter.js): as that agent (`who`), of the scene's tools alone (its
     *  issues, proposals and versions are its person's, by their own account), what it writes kept only where it may `land`: MCP's result. */
    async asAgent({ who, land }, tool, args) {
      if (["issues", "proposal", "git", "write_file"].includes(tool)) return { content: [{ type: "text", text: `error: ${tool} is your person's here, by their own account: ask them` }], isError: true };
      await model.sceneScans(page());
      const r = await model.sceneCall(who, tool, args, page(), land);
      await load();
      // (Where it looked from, as a host says it too: for it to say in its `here`, being its own peer.)
      return { content: r.content ?? [], ...(r.isError ? { isError: true } : {}), ...(r.camera ? { _meta: { camera: r.camera } } : {}) };
    },
    evidence: async () => (await draw("evidence", {})) ?? { parts: {} },
    cloud: (k = 0) => points("cloud", { scan: k }),
    slabPoints: (box, max) => points("slab", { box, max }),
    async free(box, w, h) { const b = await draw("free", { box, w, ht: h }); return b ? parseFree(b) : null; },
    selectionCloud: (sel) => points("selection", { id: sel }),
    selectionRays: async (sel) => (await draw("rays", { id: sel }))?.rays ?? [],
    pick: async (origin, dir, z, slab, pixel) => (await draw("pick", { origin, dir, z, slab, pixel })) ?? { hit: null },
  };
}

// ----- the workspace ---------------------------------------------------------------------------

export const workspace = {
  id: myId(),
  /** What this person has said they are called, for what they make where it is kept by name; none: nothing said. */
  myName() {
    try { return localStorage.getItem(NAME_KEY); } catch (_) { return null; }
  },
  setMyName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch (_) { /* not kept here */ }
  },
  /** Whether this site keeps workspaces (for the projects there that can have one: asked of each as it is opened). */
  service: false,
  /** Its state, as last said (null: none is open yet). */
  state: null,
  connected: false,
  listeners: [],
  backend: null,
  entry: null,
  /** A session this page is in (session/enter.js): who is here and what is said come from it. `{ room, state(), call(tool, args) }`:
   *  `room`, where the service is in it, so that its workspace is of the session's files. */
  together: null,

  /** How much of a scan this page's own scene reads at once (`fettled_scan::scan::Budget`: `{ points, lay_out }`); none: the engine's
   *  own. A scan with more is read as its layout's sample, and the cells a box is asked of. */
  scanBudget: null,

  /** A link to a view (as scene/links.js has one), where the scene says how: for what is said of it elsewhere. */
  viewUrl: async (_view) => null,

  /** Whether this site keeps workspaces: asked once, on load. Saves there are then this participant's. */
  async probe() {
    try {
      const r = await fetch("api/workspace", { cache: "no-cache" });
      const j = r.ok ? await r.json() : null;
      if (!j?.service) return false;
      this.service = true;
      if (storage.site) Object.assign(storage.site, { who: this.id, nameOf: () => this.nameOf?.() });
      return true;
    } catch (_) {
      return false;
    }
  },

  /** The workspace of the project the page is of, once it is open: the service's where the service keeps one of it,
   *  else its own. (One, once: another project is another page.) */
  watch() {
    const follow = (s) => { if (s?.file && !this.entry) this.open(s.file); };
    model.onChange(follow);
    follow(model.state);
  },
  async open(entry) {
    this.entry = entry;
    const said = (state, connected) => {
      if (state) this.ownState = state;
      this.connected = connected;
      this.tell();
    };
    // (Asking opens it there: a project has a workspace on the service where it is a repository of its own. In a session the service is in,
    // of the session's files: what is in one is its own till it is committed, and what is put in its scene goes in its files, for everyone.)
    const room = this.together?.room ?? null;
    const kept = this.service && (room || (storage.kind === "host" && !storage.store.base?.git)) && (await fetch(`api/workspace?part=${encodeURIComponent(entry)}`, { cache: "no-cache" }).then((r) => r.json()).catch(() => null))?.workspace;
    this.backend = kept ? served(this.id, said, entry, room) : local(this.id, said, entry);
    if (kept) proposing.inIssue = (args) => this.call("propose", args);
    this.backend.start();
  },
  /** The state as it now is, said to everyone. */
  tell() {
    if (!this.ownState) return;
    this.state = this.together ? { ...this.ownState, ...this.together.state() } : this.ownState;
    for (const f of this.listeners) f(this.state);
  },
  /** What a session says has changed. */
  refresh() {
    this.tell();
  },
  /** `f(state)` on every change. */
  onState(f) {
    this.listeners.push(f);
  },

  can(what) {
    const s = this.state;
    if (what === "scan") return !!s?.scan;
    if (what === "rays") return !!s?.scan?.rays;
    if (what === "shared") return !!this.backend?.shared;
    if (what === "issues") return !!this.backend?.shared || !!this.backend?.issues;
    if (what === "people") return !!this.backend?.shared || !!this.together;
    throw new Error(`workspace.can: ${what}?`);
  },

  /** This browser's participant, once the workspace knows it. */
  me() {
    return this.state?.participants.find((p) => p.id === this.id) ?? null;
  },
  participant(id) {
    return this.state?.participants.find((p) => p.id === id) ?? { id, name: id, kind: "person", colour: "#888" };
  },

  /** Runs a tool: `{ text, images, error }`. */
  call(tool, args = {}) {
    const theirs = this.together?.call(tool, args);
    if (theirs) return theirs;
    // (What a project's versions and files are is the page's to ask wherever they are kept: one way, for a person and an agent in the page alike.)
    if (tool === "git") return git(args);
    if (tool === "write_file") return storage.store.write(args.file, args.text, { base: args.base }).then(() => ({ text: `wrote ${args.file}`, images: [] }), failed);
    return this.backend ? this.backend.call(tool, args) : Promise.resolve(failed("no project is open"));
  },
  /** A tool call by an agent this page is the tool host of: MCP's result. */
  asAgent(cap, tool, args) {
    return this.backend?.asAgent ? this.backend.asAgent(cap, tool, args) : Promise.resolve({ content: [{ type: "text", text: "error: this page's tools are its host's" }], isError: true });
  },
  /** What the scan says of each member, by path: `{ parts: { path: { colour, evidence } } }`. */
  evidence() { return (this.backend ?? NONE_OPEN).evidence(); },
  /** A proposal (by its commit) as before / after / changes / diff / offer. */
  diff(commit) { return this.backend ? this.backend.diff(commit) : Promise.resolve({ error: "no project is open" }); },
  /** The scan, thinned to draw. */
  cloud(k = 0) { return (this.backend ?? NONE_OPEN).cloud(k); },
  /** Every point in a box ({ c, u, v, n, h }: centre, unit axes, half sizes; scan frame), thinned to `max` (none: as many as the scene draws of one). */
  slabPoints(box, max) { return (this.backend ?? NONE_OPEN).slabPoints(box, max); },
  /** Free space in a box, over its first two axes: { w, h, max, data } (a byte per cell: how many rays pass over it, on a logarithmic scale; row 0 at the low side of the second axis). */
  free(box, w, h) { return (this.backend ?? NONE_OPEN).free(box, w, h); },
  /** A selection's points (thinned), to draw. */
  selectionCloud(id) { return (this.backend ?? NONE_OPEN).selectionCloud(id); },
  /** A selection's rays, sampled: [[sensor, point], …] (scan frame). */
  selectionRays(id) { return (this.backend ?? NONE_OPEN).selectionRays(id); },
  /** What a ray meets of the scan (scan frame); `z` (model frame) and `slab` (a box, as above) are the view's cuts;
   *  `pixel` (a view's `pixel()`): met as near the cursor as the view shows it. */
  pick(origin, dir, z, slab, pixel) { return (this.backend ?? NONE_OPEN).pick(origin, dir, z, slab, pixel); },
};
