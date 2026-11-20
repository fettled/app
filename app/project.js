// The open workspace, in the page: its files, wherever they are kept (store.js), and the models of the root parts open in it
// as their engines build them from them (each root part's engines: worker.js, off the page's thread).
//
//   storage   where workspaces are kept: which store, and choosing another
//   project   which workspace is open, and which of its root parts (any number, each kept as long as the page is; one of them
//             focused): listing them, going to another workspace (the page is loaded again with it: nothing of the one open
//             is left), its files and saving them
//   model     the focused root part's model as built: its state (said again whenever it is built
//             again, or another is focused), its parts, and whatever else is asked of it (a sheet, a member's checks…);
//             and whether it is being built again (`solving`)
//
// Whatever is asked of the project or the model answers with what was asked for, or
// `{ error }`: nothing here throws at who asks.

import { WORKSPACE_NAME, dirOf, homeOf, idOf, nameOf, pathIn, within, workspaceName, workspaceOf } from "./ids.js";
import { GitHub } from "./github.js";
import { forgetGitObjects, BranchStore, BrowserStore, FolderStore, HttpStore, LOCAL_ONLY, OverlayStore, githubBranch, githubPlace, keepGithub, readGithub, settings, tokenRefused } from "./store.js";
import { AtCommit, BranchWork, editsOf } from "./work.js";
import { auth } from "./auth.js";
import { EXAMPLES } from "./config.js";
import { scriptsBuild } from "./report.js";
import { asked, began, idle, reached, step, trace, tracing } from "./times.js";
import { cacheOf } from "./cache.js";
import { Builds } from "./builds.js";
import { keep as keepSettled, kept as keptSettled, forget as forgetSettled, keyOf } from "./settled.js";
import { showsFixings } from "./filters.js";
import { trouble } from "./report.js";


// ----- the engine ---------------------------------------------------------------------------

/**
 * An engine in a worker of its own (`name`: which, where what is asked of it is timed): `ask(op, args)` answers
 * with what it says, or throws what it throws (`as`: what the asking is timed as, where not as its op).
 * `ask.restart()`: what it is doing is let go of (its worker ended, what was asked of it failing as cancelled) and
 * it is started again, with nothing: a build of what was changed since need not wait for one of what was.
 * `ask.busy()`: whether something asked of it is not answered yet.
 */
function startEngine(name, label = name) {
  let worker, nextId = 1, tries = 0;
  /** Why it cannot be started, where it could not be after `START_TRIES`: what is asked of it fails with that, at once. */
  let broken = null;
  /** What is asked of it and not answered: each with what was sent, to send again to a worker started in place of one that never ran. */
  const pending = new Map();
  const start = () => {
    // (Whether its scripts are loaded and running: it says so with its first message, `step`. Until then, an `error` is of
    // their loading: one of them was not had, as when the server refuses the connection for a moment.)
    let running = false;
    const w = (worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" }));
    w.onmessage = (e) => {
      if (w !== worker) return;
      running = true;
      tries = 0;
      // (A step of its work: in the build log, on the page's clock.)
      if ("step" in e.data) return step(label, e.data.step, e.data.t - performance.timeOrigin);
      const { id, ok, value, error, ms } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      p.answered(ms);
      ok ? p.resolve(value) : p.reject(new Error(error));
    };
    w.onerror = (e) => {
      if (w !== worker) return;
      const why = e.message || "one of its scripts could not be loaded (see the console)";
      // Running: something it was doing threw, and nothing it is doing will be answered.
      if (running) {
        for (const p of pending.values()) { p.answered(0); p.reject(new Error(`the engine failed: ${why}`)); }
        pending.clear();
        return;
      }
      // Not running: nothing sent to it was heard, nor will be. It is started again, and sent all that is asked of it; and where it
      // will not start, what is asked fails, saying why (and the page says so: `onBroken`).
      e.preventDefault();
      w.terminate();
      if (++tries < START_TRIES) {
        step(label, `could not start (${why}): starting it again`);
        setTimeout(() => {
          if (worker !== w) return;
          start();
          for (const p of pending.values()) worker.postMessage(p.sent);
        }, 250 * 2 ** tries);
        return;
      }
      broken = new Error(`the ${name} engine could not be started: ${why}`);
      step(label, broken.message);
      idle(label);
      for (const p of pending.values()) { p.answered(0); p.reject(broken); }
      pending.clear();
      engineBroken(broken);
    };
  };
  start();
  const ask = (op, args, as) => new Promise((resolve, reject) => {
    if (broken) return reject(broken);
    const id = nextId++, sent = { id, op, args };
    pending.set(id, { resolve, reject, sent, answered: asked(name, as ?? (op === "request" ? args.op : op), label) });
    worker.postMessage(sent);
  });
  ask.restart = () => {
    if (broken) return;
    worker.terminate();
    for (const p of pending.values()) { p.answered(0); p.reject(new Error(CANCELLED)); }
    pending.clear();
    step(label, "let go of what it was doing: started again");
    idle(label);
    start();
  };
  ask.busy = () => pending.size > 0;
  /** Ended, for good: what is asked of it and not answered fails. */
  ask.stop = () => {
    worker.terminate();
    broken = new Error("the engine was closed");
    for (const p of pending.values()) { p.answered(0); p.reject(broken); }
    pending.clear();
  };
  return ask;
}
/** What a thing asked of an engine that was started again fails with. */
const CANCELLED = "cancelled: the engine was started again";
/** How many times an engine whose scripts were not loaded is started before it is given up on. */
const START_TRIES = 4;
/** An engine that could not be started: reported, and said to whoever listens (`model.onBroken`). */
function engineBroken(e) {
  trouble("engine", e);
  for (const f of model.brokenListeners) f(e);
}
/**
 * The engines (docs/engines.md), by what they do. Each root part open has a **model engine**, which takes its settled model
 * (from what was kept of it, or from its solver) and answers what is asked of it, making each product of it when first
 * asked for (its bodies and parts, its checks, its scene); it solves nothing, and answers while a solve is under way, of
 * the model as it was. And a **solver**, started when something needs one (a model not kept, a file changed, another
 * scenario, or the script's own state: a drag), which runs its script, settles it and hands out what it settled. The page
 * has one **background engine**, for what takes seconds and holds up nothing that is shown: sheets drawn, where bodies
 * meet; it keeps the last few settled models it was handed, of any root part, by their keys.
 * (`also`: what their names in the build log say beside which they are, for the root parts after the page's first.)
 */
/** Every engine started, to end with the page. */
const all = new Set();
const engine = (name, label) => { const e = startEngine(name, label); all.add(e); return e; };
// (The page going: its engines ended with it, at once, and not when the browser gets to it, so that whatever it is going
// to, the page loaded again, say, does not wait behind a build of this one's. Not where the browser keeps the page as it is,
// to come back to (`persisted`: its engines are stopped with it meanwhile, and go on when it is shown again): ended, it came
// back with a model that nothing could be asked of, and the next build of it failed, "the engine was closed".)
addEventListener("pagehide", (e) => { if (!e.persisted) for (const x of all) x.stop(); });
/** A model engine started as the page loads, before it knows what it is of (starting one takes a while): the first root
 *  part opened takes it; till then, what is asked of an engine with none open (a new workspace's model, which build this
 *  is) is asked of it. */
let spare = engine("model");
/** An engine to ask what is not of any one model: the focused root part's model engine, or the spare one. */
const anyEngine = () => focused?.reader ?? spare;
/** The page's background engine, started when first wanted. */
let background = null;
const backgroundEngine = () => (background ??= engine("background"));
/** How many settled models it keeps. */
const BACKGROUND_KEEPS = 3;
/** Which settled models the background engine has been handed (by key), and the load cases each leaves out. */
const handed = new Map();
/** Which build of the engine this is (what a model it settles is kept by). */
let stampOf = null;
const stamp = () => (stampOf ??= anyEngine()("stamp"));
let buildOf = null;
/** Which build of the app this page is: `{ engine }`, its engine's stamp (what decides how a model builds and solves), and as a person can
 *  tell builds apart, as web/build.sh compiled into the engine: `commit`, `date` (the commit's, ISO), `changed` (built with changes beside
 *  it); `at`, where the page was loaded from; and `js`, the page's scripts, said the same way (`{ commit, date, changed }`, or `{}`). */
export const appBuild = () => (buildOf ??= Promise.all([stamp(), anyEngine()("build").catch(() => ({})), scriptsBuild()]).then(([engine, said, js]) =>
  ({ engine, commit: said.commit || null, date: said.date || null, changed: !!said.changed, at: location.host, js: { commit: js.commit || null, date: js.date || null, changed: !!js.changed } })));
/** A build, for a person: when its commit was made and which it is, or (none said) its engine's stamp. */
export function buildName(b) {
  if (!b?.commit) return b?.engine ? `engine ${b.engine.slice(0, 8)}` : "unknown";
  const d = new Date(b.date), at = isNaN(d) ? "" : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · `;
  return `${at}${b.commit}${b.changed ? " with changes" : ""}`;
}
/** How someone's build stands to this one: "same" (the same engine), "older", "newer" (by their commits' dates), or "other". */
export function buildBeside(theirs, mine) {
  if (!theirs?.engine || !mine?.engine || theirs.engine === mine.engine) return "same";
  const t = Date.parse(theirs.date), m = Date.parse(mine.date);
  return t < m ? "older" : t > m ? "newer" : "other";
}
/** What a project's settled model is kept by here: in which store, which model. */
const settledId = (entry) => `${storage.store.label}\n${entry}`;
/** How many builds there have been, of every root part in the page: which one each is (`version`), for all of its engines alike,
 *  and none of one root part's the same as another's. */
let builds = 0;

/** What is tried out over a model: whether it is a file of that. */
const isScratch = (id) => id.endsWith(".scratch.gen.ts");
const scratchIdOf = (entry) => entry.replace(/\.ts$/, ".scratch.gen.ts");
const scratchKeyOf = (entry) => `scratch\n${storage.store.label}\n${entry}`;
/** The keys of what is tried out (`"param ADDRESS"`, a drag's key), as a text of it has them. */
const keysIn = (text) => [...(text ?? "").matchAll(/^ {2}("(?:[^"\\]|\\.)*"): /gm)].map((m) => JSON.parse(m[1]));
/** The keys of what is tried out over the focused root part. */
export const scratchKeys = () => keysIn(focused?.scratch.text);
/** Whether anything is tried out. */
export const tryingOut = () => scratchKeys().length > 0;
/** Whether the model is shown as it was before what is tried out (which is then not to be added to). */
export const showingBefore = () => !scratch.on && tryingOut();
/** Who hears of what is tried out changing, of the focused root part (or another being focused). */
const scratchListeners = new Set();
/**
 * What is tried out over the focused root part's model (docs/layers.md: the scratch layer, over yours): the text of its layer file,
 * which the page alone keeps (in this browser, for this model; never in the project, nor sent to others in a session); whether it is
 * built in (`on`: off, the model is shown as it is without it, to compare); and its texts before (`back`) and after (`ahead`) each
 * change, to undo and redo. (Each root part has its own; this is the focused one's.)
 */
export const scratch = new Proxy({ listeners: scratchListeners }, {
  get: (t, k) => (k in t ? t[k] : focused?.scratch[k] ?? (k === "back" || k === "ahead" ? [] : k === "on" ? true : null)),
  set: (t, k, v) => { if (focused) focused.scratch[k] = v; return true; },
});

/** What is asked of the background engine: what takes seconds, and holds up nothing shown (its structure carried down and
 *  checked, and all that is made of that; its sheets as said, and drawn): the model engine answers the rest at once. */
const OF_BACKGROUND = new Set(["analysis", "structure", "ratios", "deflected", "member", "fastenings", "stock", "nest_parts", "nest_dxf", "sheet", "exports", "export", "heat", "pick"]);
/** `f()` once the page has nothing else to do (or soon, where the browser does not say). */
const whenIdle = (f) => (globalThis.requestIdleCallback ? requestIdleCallback(() => f(), { timeout: 4000 }) : setTimeout(f, 200));
/** What something answers, or `{ error }` where it throws. */
const answered = async (f) => { try { return await f(); } catch (e) { return { error: String(e?.message ?? e) }; } };


// ----- storage --------------------------------------------------------------------------

// Where projects are kept: the locations this page can reach, each a store (store.js), all listed on the projects page;
//   host     the fettled host the page is served by, where it is (`fettled serve`: its folders; a static site: its files,
//            read-only, with edits kept in this browser);
//   browser  this browser;
//   folder   a folder on this computer, picked here (the browser lets the page use it: Chrome, Edge), as long as the
//            browser lets it (again after the page is loaded, once asked by a click).
// A page's project is in one of them, as its address says (`in`): that one is `store`, what everything of the project is
// read from and written to.
/** The location of a session on a host, shared over the internet: its room is on the relay. */
export const RELAYED = "relayed";

/** The examples' place: their branch on GitHub, listed always (`EXAMPLES`), by itself rather than among those followed. */
export const EXAMPLES_KIND = `github:${EXAMPLES.repo}@${EXAMPLES.branch}`;

/** Whether a location is built-in: the examples, and a published site's own files. Read-only: what is made again of
 *  them, and the viewer's own layer (LOCAL_ONLY), is kept in this browser; anything else is changed in a copy of one's own. */
export const isBuiltin = (kind) => kind === EXAMPLES_KIND || (kind === "host" && !!storage.site && !storage.site.writable);
/** What a built-in workspace says of a write to it. */
export const READ_ONLY = "a built-in workspace is read-only: copy it to a place of your own to change it";
/** A store made read-only (but for what is kept only here). (Edits it kept from before stay there, to be copied or let go of.) */
function lockEdits(made) {
  const write = made.write.bind(made);
  made.write = (id, text, opts) => (LOCAL_ONLY.test(id) ? write(id, text, opts) : Promise.reject(new Error(READ_ONLY)));
  made.readOnly = true;
  made.writable = false;
}
/** What a copy leaves: pictures, scans, archives (no place here is written bytes); any other file that is not text (a binary STL) is found as it is read. */
const NOT_TEXT = /\.(png|jpe?g|gif|webp|heic|hdr|exr|tiff?|ply|pcd|e57|las|laz|bin|bag|glb|3mf|pdf|zip|gz|mp4|mov|wasm)$/i;
/** How many files a copy reads at once. */
const COPYING_AT_ONCE = 8;

export const storage = {
  /** The store of the page's project (none: the page is of no project). */
  store: null,
  /** Its versions, where it has them (work.js says what kinds there are): null where it has none, or they are not yet known of. */
  work: null,
  /** Which location that is ("host", "browser", "folder", or a branch on GitHub: `github:owner/name@branch`). */
  kind: null,
  site: null, // the HttpStore, if this page is served with files
  folder: null, // the folder picked here last, if one was (a FolderStore)
  folderLet: false, // whether the browser lets the page use it now
  github: { token: null, repos: [] }, // the branches on GitHub listed here (their locations' names), and the token for them
  stores: {},
  /** What locations there are, and the folder's state: as the page is loaded. */
  async boot() {
    this.site = await HttpStore.detect();
    this.folder = FolderStore.supported() ? await FolderStore.remembered().catch(() => null) : null;
    this.folderLet = !!this.folder && (await this.folder.permitted(false).catch(() => false));
    this.github = await readGithub();
  },
  /** The repositories the person signed in can reach, to pick from: a page of GitHub's at a time (github.js, `reachable`). */
  reachable() {
    return new GitHub({ token: auth.token, api: this.github.api ?? auth.app.api }).reachable();
  },
  /** The store of a location, where the page can use it now; else null. (Each made once: what it writes is kept track
   *  of, and the page is not left till it is written.) A branch on GitHub can always be tried: an address may name one
   *  that is not listed here, and a public one needs no token. */
  of(kind) {
    if (this.stores[kind]) return this.stores[kind];
    const branch = githubPlace(kind);
    const made = kind === "host" ? this.site && (this.site.writable ? this.site : new OverlayStore(this.site, new BrowserStore("fettled-edits")))
      : kind === "browser" ? new BrowserStore()
      : kind === "folder" ? this.folderLet && this.folder
      : branch ? new BranchWork(this.branchStore(branch), editsOf(kind))
      : null;
    if (!made) return null;
    if (isBuiltin(kind)) lockEdits(made);
    this.adopt(kind, made);
    return made;
  },
  /** The workspace a location is, where it is one (a folder picked, a branch of a repository): its name; else null. */
  workspaceIn(kind) {
    const s = this.of(kind);
    return s?.workspace ?? s?.base?.git?.workspace ?? s?.git?.workspace ?? null;
  },
  /** A branch on GitHub, read as this browser can. */
  branchStore(branch, opts) {
    return githubBranch({ ...branch, ...opts, token: auth.signedIn() ? auth.token : this.github.token, api: this.github.api ?? (auth.signedIn() ? auth.app.api : undefined), web: auth.app?.login });
  },
  /** The store of a location from here on: what it writes is kept track of, and the page is not left till it is written. */
  adopt(kind, made) {
    const write = made.write.bind(made);
    made.write = (id, text, opts) => {
      const w = write(id, text, opts);
      writing.add(w);
      w.catch(() => {}).finally(() => writing.delete(w));
      return w;
    };
    this.stores[kind] = made;
  },
  /** A location as a session on it has it, in place of as this browser's person has it, for this page: `base`, the branch it is over, and
   *  `make(base, top)`, the store over that and files kept for this session alone. */
  sessionOn(kind, id, base, make) {
    const made = make(base, new BrowserStore(`fettled-session:${id}`));
    this.adopt(kind, made);
    return made;
  },
  /** The location as it was at one commit, for this page: what a link to a view opens. */
  async openAt(kind, entry, commit) {
    const place = `at:${commit}`, onBranch = githubPlace(kind);
    let base;
    if (onBranch) base = this.branchStore(onBranch, { place });
    else {
      const { HostRepo } = await import("./host-git.js"), git = new HostRepo({ entry });
      const s = await git.ask("status");
      base = new BranchStore({ git, repo: s.repo, branch: s.branch, place });
    }
    base.viewing = commit;
    await base.moveTo(commit);
    this.adopt(kind, new AtCommit(base, new BrowserStore(`fettled-at:${commit}`), kind));
  },
  /** The page's project is in this location (which it can use: `of`): where it was in another (a session begun here), whoever listens is told. */
  use(kind) {
    const again = !!this.store;
    this.store = this.of(kind);
    this.kind = kind;
    this.work = typeof this.store?.can === "function" ? this.store : null;
    if (again) for (const f of this.useListeners) f();
  },
  useListeners: [],
  /** `f()` when the page's workspace is had from another store than it was opened from: a session begun here, its files the session's. */
  onUse(f) { this.useListeners.push(f); },
  /** Finds out what versions the page's project has, where its location does not say: those of the repository it is in, on the host.
   *  (`who()`: who makes what is committed there.) */
  async findWork(entry, who) {
    if (this.work || this.kind !== "host" || !this.site?.writable) return;
    this.work = await (await import("./host-git.js")).TreeWork.of(entry, who);
  },
  /** The locations, as the projects page lists them: `{ kind, label, store }` (`store` null: it cannot be used now;
   *  the host where the page has none, the folder where none was picked or the browser no longer lets it be used). */
  locations() {
    const out = [];
    out.push({ kind: "host", label: this.site ? (this.site.writable ? this.site.label : `${this.site.label} (built-in, read-only)`) : "A fettled host", store: this.of("host") });
    out.push({ kind: "browser", label: "This browser", store: this.of("browser") });
    if (FolderStore.supported()) out.push({ kind: "folder", label: this.folder ? this.folder.label : "A folder on this computer", store: this.of("folder") });
    for (const kind of this.githubKinds()) out.push({ kind, label: this.of(kind).base.label, store: this.of(kind) });
    out.push({ kind: EXAMPLES_KIND, label: "Examples", store: this.of(EXAMPLES_KIND), examples: true });
    return out;
  },
  /** The branches on GitHub listed here: those picked, opened by name, or gone to. */
  githubKinds() {
    return this.github.repos.filter((k) => k !== EXAMPLES_KIND);
  },
  /** Whether others may be making things in the page's project at this moment, unseen by it: then things made take
   *  numbers two people will not both take, for when their work is merged. */
  sharedWithOthers() {
    return !!this.store?.sharedWithOthers;
  },
  /** A branch on GitHub listed here, with the token for this browser to read it (none given: the one it has): its
   *  location's name. (It is opened where it was left, and otherwise moves only when someone says so.) */
  async followBranch(repo, branch, token) {
    const kind = `github:${repo}@${branch}`;
    if (!githubPlace(kind)) throw new Error("a repository is owner/name, and a branch a plain name");
    const refused = tokenRefused(token);
    if (refused) throw new Error(refused);
    this.github = { ...this.github, token: token || this.github.token, repos: [...new Set([...this.github.repos, kind])] };
    // (Made again with the token.)
    for (const k of this.github.repos) delete this.stores[k];
    await keepGithub(this.github);
    return kind;
  },
  /** One no longer listed here; a pasted token is let go of with the last. (Edits kept over it stay, for if it comes back.) */
  async unfollowBranch(kind) {
    const repos = this.github.repos.filter((k) => k !== kind);
    this.github = { ...this.github, token: repos.length ? this.github.token : null, repos };
    delete this.stores[kind];
    await keepGithub(this.github);
    // (The token gone, so is what it read: it may be of private repositories.)
    if (!repos.length && !auth.signedIn()) await forgetGitObjects();
  },
  /** A folder picked (a click: from a user gesture), in place of the one before: it is the folder location now. */
  async pickFolder() {
    this.folder = await FolderStore.pick();
    this.folderLet = true;
    delete this.stores.folder;
  },
  /** The folder picked before, let in again (a click: from a user gesture): whether the browser lets it be used now. */
  async letFolderIn() {
    this.folderLet = !!(await this.folder?.permitted(true).catch(() => false));
    return this.folderLet;
  },
};


// ----- the root parts open -------------------------------------------------------------
//
// A page is of one workspace, and has any number of its parts open as the roots of models, each with its engines (a `Root`):
// kept, by its id, for as long as the page is, so that coming back to one needs nothing built again. The 3D views each show
// one of them (any number of views the same one); the one last used is focused, and what the page shows of a model besides
// (its tree, its params, its drawings, its card, its checks) is of that one (`model`, below, is it).

/** What is being written to the store: waited for before the page is left. */
const writing = new Set();

/** How many of the projects opened last are kept, to be listed first; and where (in every location's, together). */
const RECENT = 8, RECENT_KEY = "recent";
/** The name a folder's model has: a folder with one is opened by it, and the rest of the folder is what it is made of. */
const MODEL = "model.ts";
/** The folder a model is the model of (null: the model is one by itself). */
const folderOf = (entry) => (nameOf(entry) === MODEL ? dirOf(entry) : null);
/** Every file of a workspace (`home`: the start of its ids, `W:`), whichever part is open in it: `[{ id, mtime, size }]`. */
async function inWorkspace(home) {
  return (await (storage.store.all?.() ?? storage.store.list())).filter((f) => within(f.id, home)).sort((a, b) => a.id.localeCompare(b.id));
}
/** What says whether any of them has changed. */
const signOf = (all) => all.map((f) => `${f.id} ${f.mtime ?? f.size}`).join("\n");
/** Larger than this, a file is not read to be shown (bytes). */
const TOO_BIG = 2e6;
/** Whether two builds are of the same: their files (each the same text), scenario and the host's points. Not of where they were read
 *  from: the same files read from a session's store, as a session is begun, are the same build. */
const sameInput = (a, b) => !!a && !!b && a.scenario === b.scenario && a.points === b.points && Object.keys(a.files).length === Object.keys(b.files).length && Object.entries(a.files).every(([id, t]) => b.files[id] === t);
/** What the files a model is built from are watched by: not what is tried out (the page's own). */
const watched = (o) => o.ids.filter((id) => !isScratch(id));
/** What the app keeps of settles of a model (`cache.js`), by its id there (`settles/KEY.json`, the engine's): of its workspace, where it
 *  is of one (`W:settles/KEY.json`). */
const keptIdOf = (entry, id) => `${/^[^:/]+:/.exec(entry)?.[0] ?? ""}${id}`;

/** The root parts open, by id; and the one focused (none: none is open yet). */
const roots = new Map();
let focused = null;
/** The root part the page was opened with, from when it is asked to be opened. */
let opened = null;
/** The files of the workspace, as last listed (one listing for every root part): `{ all, at }`. */
let listed = { all: null, at: 0, sign: "" };
/** One look at the workspace's files at a time. */
let listing = Promise.resolve();

/** One root part, open: its files, its engines, and its model as they build it. */
class Root {
  constructor(entry, reader, also) {
    this.entry = entry;
    /** Its model engine: what everything of its model as settled is asked of. */
    this.reader = reader;
    /** Its solver, once one is wanted; and what it has built (its settle's key; none: nothing, or let go of). */
    this.solver = null;
    this.solved = null;
    /** What its engines are called in the build log, beside which they are (none, of the page's first root part). */
    this.also = also;
    /** What its steps are in the build log: the page's, for its first; `page · NAME`, for another. */
    this.steps = `page${also}`;
    /** The settled model its model engine has (its key, and its bytes: what the background engine is handed). */
    this.key = null;
    this.bytes = null;
    /** What a host serving it says of its model (`hostSaid`): the key of the points it has read of its point clouds and settled it
     *  of, said only of a model whose scopes read them (none: none, or no host), which every build is handed; and its settle's
     *  number, which a build that wanted its points waits for. */
    this.points = null;
    this.hostRev = null;
    this.hostEngine = null;
    /** Whether its last build wanted its point clouds' points (its solver reads none: it takes a host's settle of them). */
    this.wantsPoints = false;
    /** Whether its next build is to settle from its files alone, nothing kept of settles before taken (`rebuildFresh`). */
    this.fresh = false;
    /** What is tried out over it (`scratch`, above, of the one focused). */
    this.scratch = { on: true, text: null, back: [], ahead: [] };
    /** Its builds (builds.js): what may change what it is built of says so (`want`), and one loop builds it as it then is
     *  (`buildOnce`). Whether the next build is to build its solver too (what needs its script), where its model engine has the
     *  model already. */
    this.builds = new Builds({
      once: (reasons, stale) => this.buildOnce(reasons, stale),
      cancelled: (e) => String(e?.message ?? e) === CANCELLED,
      cancel: () => { if (this.solver?.busy()) { this.solver.restart(); this.solved = null; } },
      began: () => { this.solving = { since: performance.now() }; this.solvingSaid(); },
      ended: () => { this.solving = null; this.solvingSaid(); },
      failed: (e) => this.failed(e),
      // (Said as soon as it is built, not when it is next looked at; after whoever waited for it has gone on.)
      built: () => setTimeout(() => this.look().catch(() => {})),
      trace: (data) => trace("build", { entry: this.entry, ...data }),
    });
    this.needSolver = false;
    /** What it is built of, besides its files: its scenario, and the load cases its checks leave out (which build nothing: its model
     *  engine makes its checks again). */
    this.wanted = { entry: null, scenario: null, names: null };
    /** What the model it has was built of (`buildOnce`'s input: its files, scenario and the host's points), and its files. */
    this.builtOf = null;
    this.asBuilt = {};
    /** Its files: `{ entry, home, ids, sizes, stamps }`, once read. */
    this.open = null;
    /** One look at its files at a time: two at once would each find the same change, and build it twice. */
    this.looking = Promise.resolve();
    this.lastCheck = 0;
    /** The model engine's state of its model, as last asked (`version`: another on every build; `file`: the root part). */
    this.state = null;
    /** What checking where its bodies meet found (`{ version, said }`): of which build. */
    this.checks = null;
    /** While it is being built again, how far that has come (`model.solving`); null: it is not. */
    this.solving = null;
    /** Who hears of its changes, whether it is focused or not (each `f(state, was)`): the views of it. */
    this.listeners = new Set();
  }
  get focused() { return focused === this; }

  // ----- its engines ---------------------------------------------------------------------

  /** What is asked of its model as settled: of its model engine. */
  engine(op, args) { return this.reader(op, args); }
  /** Its solver: started where it is not. */
  solverEngine() {
    if (!this.solver) { this.solver = engine("solver", `solver${this.also}`); this.solved = null; }
    return this.solver;
  }
  /**
   * What needs its script's own state (a drag, a param dragged, what is kept beside it made again): asked of its solver,
   * once that has built what the model engine has (where it has not, as on a page loaded from what was kept, it is built
   * first; the model engine's is then not taken again, being the same). While a drag holds it, of that drag's solver as it is.
   */
  async script(op, args, { hold = false } = {}) {
    if (!this.builds.dragging) {
      await this.idle();
      if (!this.solver || this.solved !== this.key) await this.want("its script is needed", { solver: true });
    }
    if (hold) this.builds.hold();
    return this.solver(op, args);
  }
  /** What a host serving it says of its model (its scene's `model`): `points_key`, the key of the points it has read of its point
   *  clouds and settled it of (said only of a model whose scopes read them), and `rev`, another each time it settles it. Built
   *  again where the key is another (it is handed it), or where its last build wanted its points and the host has settled it since. */
  hostSaid(m) {
    const points = m?.points_key ?? null, rev = m?.rev ?? null;
    const other = points !== this.points, settled = rev !== this.hostRev;
    this.points = points;
    this.hostRev = rev;
    // (Which engine the host settles it with: what its settle is kept by. Of another than this page's, it is not taken here.)
    const engine = m?.engine ?? null, engineSaid = engine !== this.hostEngine;
    this.hostEngine = engine;
    trace("host", { entry: this.entry, points, rev, other, wantsPoints: this.wantsPoints });
    if (!this.open) return;
    if (other) this.want("the host's points").catch(() => {});
    else if (this.wantsPoints && settled) this.want("the host settled it").catch(() => {});
    else if (this.wantsPoints && engineSaid) this.want("the host's engine was said").catch(() => {});
  }
  /** Answers once nothing is being built, or waits to be. */
  idle() { return this.builds.idle(); }
  /** What an engine has made of the model, written (as made from the files it was built from: what others have changed since, in a session, stays);
   *  what is tried out (the scratch layer), kept by the page and never written. */
  keepOf(w) { return isScratch(w.id) ? this.setScratch(w.text) : storage.store.write(w.id, w.text, { base: this.asBuilt[w.id] }); }
  saidScratch() {
    if (this.open) settings.set(scratchKeyOf(this.open.entry), { on: this.scratch.on, text: this.scratch.text }).catch(() => {});
    if (this.focused) for (const f of scratchListeners) f();
  }
  /** What is tried out as `text`, the change kept to undo. */
  setScratch(text, undoable = true) {
    const s = this.scratch;
    if (text === s.text) return;
    if (undoable) { s.back.push(s.text); s.ahead = []; }
    s.text = text;
    this.saidScratch();
  }
  /** What is tried out, as it was kept here for this model (none: nothing). */
  async loadScratch() {
    const k = await settings.get(scratchKeyOf(this.entry)).catch(() => null);
    Object.assign(this.scratch, { on: k?.on ?? true, text: k?.text ?? null, back: [], ahead: [] });
  }
  /** What a build of these is kept by (`settled.js`): its files, its scenario, and the host's points it is handed. */
  async keyOf(input) {
    return keyOf({ stamp: await stamp(), place: storage.store.label, entry: input.entry, files: input.files, scenario: input.scenario, points: input.points });
  }
  /**
   * A settled model of it (its `bytes`, settled from what `key` says, of `files`) taken by its model engine, as a build of its own:
   * from now, what is asked of the model is of it. Its files go with it (its scene reads and writes them).
   */
  async take(bytes, key, input) {
    const version = ++builds;
    this.broken = null;
    await this.reader("adopt", { key, settled: bytes, version });
    Object.assign(this, { key, bytes, builtOf: input, asBuilt: input.files });
    await this.reader("files", { files: input.files }).catch(() => {});
    return version;
  }

  // ----- building: one input, one loop ---------------------------------------------------------------------
  //
  // Whatever may change what it is built of (its files, as someone edits them; its scenario; what is tried out; a host's points)
  // only says so (`want`): nothing is built there. One loop (builds.js) builds it (`buildOnce`) as it is when each build begins: its files read
  // from the store then (never as they were read before), its scenario, and the host's points; all of it one key (`keyOf`). A
  // build that something has changed under while it ran is let go of, never taken: the model shown is never of less than was
  // wanted when it began. Of the same key as it has, nothing is built. A build that fails is said, and tried again. No build
  // takes the solver from under a drag. `?trace=build` says each (times.js).

  /** What it is built of may have changed (`reason`, as the trace says it): built again, as it then is (`Builds.want`). `solver`: its
   *  solver is to have built it too (what needs its script), where its model engine has it already, kept. */
  want(reason, { solver = false } = {}) {
    if (solver) this.needSolver = true;
    this.solvingSaid();
    return this.builds.want(reason);
  }
  /**
   * One build, of it as it is now: `{ version, said }` (`said`: what the trace says of it), or `{ superseded }` where what it is
   * built of changed while it ran (nothing of it is taken). Throws where the engine fails (its script's errors are its state).
   */
  async buildOnce(reasons, stale) {
    const o = this.open, entry = this.entry;
    // (Its files, as the store has them now; their stamps as they were before they were read, so that one changed while it was
    // read is found changed again.)
    const { files, stamps } = await this.gather({}, true);
    o.ids = Object.keys(files);
    o.stamps = stamps;
    const input = { entry, files, scenario: this.wanted.scenario, points: this.points };
    const key = await this.keyOf(input), fresh = this.fresh, needSolver = this.needSolver;
    const said = { key: key.slice(0, 12), points: input.points?.slice(0, 12) ?? null, files: o.ids.length };
    if (stale()) return { superseded: true };
    // (Of the same as it has (however it was read: a session begun reads the same files from its own store), and its solver has it
    // where that is needed: nothing to build.)
    if (!fresh && sameInput(input, this.builtOf) && (!needSolver || this.solved === this.key) && this.broken == null) return { version: this.state?.version, said: { ...said, result: "same" } };
    // (As it was last settled here, of just this: taken by its model engine, and nothing built, till something needs its script.)
    if (!fresh && !needSolver && !sameInput(input, this.builtOf)) {
      const was = await keptSettled(settledId(entry), key);
      if (stale()) return { superseded: true };
      if (was) {
        step(this.steps, "taking it as it was last settled");
        const version = await this.take(was, key, input);
        return { version, said: { ...said, result: "kept" } };
      }
    }
    // Built by its solver: its script run; what is kept of settles it may begin from found by their keys (of the same files, the same
    // engine and, where its scopes read them, the same points, so whoever settled it found what it would; of a fresh build, none);
    // and settled.
    this.fresh = false;
    this.needSolver = false;
    const solver = this.solverEngine();
    this.solved = null;
    const { wanted } = await solver("open", { entry, files, scenario: input.scenario, version: builds + 1, points: input.points });
    let found = [];
    if (wanted) {
      const c = cacheOf(storage);
      found = fresh ? [] : (await Promise.all(wanted.map(async (k) => [k, await c.get(keptIdOf(entry, `settles/${k}.json`))]))).filter(([, t]) => t != null);
      ({ wantsPoints: this.wantsPoints } = await solver("settle", { found, points: input.points }));
    }
    Object.assign(said, { found: `${found.length} of ${wanted?.length ?? 0}`, wantsPoints: this.wantsPoints });
    if (stale()) return { superseded: true };
    // (Its script does not build, or it wants its points: said as its state, as its solver has it, in place of the model as it was,
    // till it builds again.)
    const tried = await solver("state");
    // (It wants its points, and waits for the host's settle: which is kept by the host's engine, and never found by a page of
    // another. Said plainly, in place of that it is waited for: a page loaded before the app was built again has the engine it was
    // loaded with, and loading it again gives it the one now served; if that is still another, the two were built apart.)
    if (tried?.error && this.wantsPoints && this.hostEngine) {
      const mine = await stamp().catch(() => null);
      if (mine && mine !== this.hostEngine) tried.error = `${entry}: this page's engine (${mine.slice(0, 8)}) is not its server's (${this.hostEngine.slice(0, 8)}). Reload the page; if it still says so, build both again.`;
    }
    // (Or it has something tried out over it, which is this page's alone: its host settles its files, and what is tried out is none
    // of them, so the model with it is settled nowhere. Said, with what to do, in place of that it is waited for.)
    if (tried?.error && this.wantsPoints && files[scratchIdOf(entry)] != null && !/this page's engine/.test(tried.error)) {
      tried.error = `${entry}: what is tried out here is not fitted. Its server fits this model, from its files alone. Clear what is tried out, or keep it (Trying out, over the 3D view).`;
    }
    if (tried?.error) {
      const version = ++builds, was = this.state;
      this.state = { ...tried, version };
      this.broken = version;
      await this.said(this.state, was);
      return { version, said: { ...said, result: "error", error: tried.error.slice(0, 120) } };
    }
    // (How it was settled, kept by its key; the model as settled, kept here, and taken by its model engine: unless it has that
    // already, from what was kept of it.)
    await this.keepSolved();
    let version = this.state?.version, result = "solver";
    if (fresh || !sameInput(input, this.builtOf) || this.broken != null) {
      const bytes = await solver("settledOut");
      if (stale()) return { superseded: true };
      // (Kept as it is taken, and waited for, as what is written is before the page is left: a page loaded again at once finds it.)
      const kept = keepSettled(settledId(entry), key, bytes).catch(() => {});
      writing.add(kept);
      kept.finally(() => writing.delete(kept));
      version = await this.take(bytes, key, input);
      await kept;
      result = "built";
    }
    // (Its solver has what its model engine has: the same build, however it was read.)
    this.solved = this.key;
    return { version, said: { ...said, result } };
  }
  /** Something of the build has changed (it began, ended, or another change waits for it), and whoever shows it is told. */
  solvingSaid() {
    const s = this.solving;
    if (s) this.solving = { ...s, queued: this.builds.wants.length };
    if (this.focused) for (const f of model.solvingListeners) f(this.solving);
  }
  /** The model file and every local file it imports, and your layer over it if there is one, and what is tried out over it where it is built
   *  in (`tried`); `instead`: files (by id) as they would be, in place of those kept. `stamps`: of each file read from where it is kept,
   *  what the store says of it (`stat`) as it was read, the two from one look at it (`readStamped`): so that one changed since, even
   *  while the others were read, is found changed when next looked at. (Which files they are is known only as they are read.) */
  async gather(instead = {}, tried = false) {
    const entry = this.entry, read = async (id) => (instead[id] != null ? { text: instead[id] } : storage.store.readStamped(id));
    // (Each file is read as soon as something is known to import it: not one after another.)
    const files = {}, stamps = {};
    const take = async (id) => {
      if (id in files) return;
      files[id] = null;
      const { text, stamp } = await read(id);
      if (text == null) throw new Error(`cannot read ${id}`);
      files[id] = text;
      if (stamp !== undefined) stamps[id] = stamp;
      await Promise.all((await this.engine("imports", { source: text, id }).catch(() => [])).map(take));
    };
    // (Your layer over it (docs/layers.md), not imported by it, if there is one.)
    const userId = entry.replace(/\.ts$/, ".user.gen.ts");
    const [, user] = await Promise.all([take(entry), read(userId).catch(() => ({ text: null }))]);
    if (user.text != null) { files[userId] = user.text; if (user.stamp !== undefined) stamps[userId] = user.stamp; }
    const s = this.scratch;
    if (tried && s.on && keysIn(s.text).length) files[scratchIdOf(entry)] = s.text;
    return { files, stamps };
  }
  /** What the scene made for the app to keep (a scan's confidence), kept where the app keeps such things (`cache.js`). */
  async keepScenes() {
    for (const [id, bytes] of await this.engine("sceneTakeKept", {}).catch(() => [])) await cacheOf(storage).set(id, bytes);
  }
  /** Of a part script, built: what is new of how it was settled, kept by its key (`settles/KEY.json`: never in place of another's). */
  async keepSolved() {
    const all = (await this.solver?.("partSolved").catch(() => null)) ?? [];
    for (const w of all) cacheOf(storage).set(keptIdOf(this.entry, w.id), w.text);
  }
  /**
   * What the background engine makes of its settled model as it now is (`op`, with `args`): handed it there first, where it
   * has not been, with the load cases its checks leave out.
   */
  async background(op, args = {}) {
    const key = this.key, bytes = this.bytes, names = this.wanted.names ?? [];
    if (!key) throw new Error("it is not built");
    const e = backgroundEngine();
    // (Handed once, whoever asks meanwhile waiting for that; again where it has let go of it since, keeping others.)
    let h = handed.get(key);
    if (h && !h.handing && !(await e("has", { key }))) { handed.delete(key); h = null; }
    if (!h) {
      h = { names: [], handing: e("adopt", { key, settled: bytes, version: this.state?.version ?? builds, keep: BACKGROUND_KEEPS }).finally(() => { h.handing = null; }) };
      handed.set(key, h);
    }
    await h.handing;
    if (JSON.stringify(h.names) !== JSON.stringify(names)) {
      h.names = names;
      await e("exclude", { key, names });
    }
    return e(op, { ...args, key });
  }
  /**
   * Where its bodies meet as they should not (the `clashes` product), of the build its model engine has: found by the
   * background engine where it is not said already (with its settle, or kept here of it), kept here by its settle's key, and,
   * where its solver has that settle, with how it was settled. Said to whoever listens. Seconds, of a model of many parts:
   * asked for by what shows it, and once the page is idle.
   */
  async clashes() {
    const version = this.state?.version, key = this.key;
    if (version == null || !key || this.checks?.version === version) return this.checks;
    let said = await keptSettled(`${settledId(this.entry)}\nclashes`, key).catch(() => null);
    if (said == null) {
      const c = await answered(() => this.background("partChecks"));
      if (!c || c.error || this.key !== key) return this.checks;
      // (Said with its settle already: nothing more.)
      said = c.said ?? [];
      if (c.said != null) {
        keepSettled(`${settledId(this.entry)}\nclashes`, key, c.said).catch(() => {});
        if (this.solved === key) { await this.solver("partChecked", { key: c.key, said: c.said }).catch(() => {}); await this.keepSolved(); }
      }
    }
    if (this.key !== key) return this.checks;
    this.checks = { version, said };
    if (this.focused) for (const f of model.checkedListeners) f(this.checks);
    return this.checks;
  }

  // ----- its files ---------------------------------------------------------------------

  /** Reads its files, and has it built: shown at once as it was last settled here, where that was of just these files. */
  async openFiles() {
    const entry = this.entry;
    step(this.steps, "reading the files it is built from");
    await this.loadScratch();
    const { files, stamps } = await this.gather({}, true);
    // Which root part is open is said now: its files are watched from here (one changed while it is first built is built in place
    // of what it was), and read, saved and looked at.
    const all = listed.all ?? [];
    this.open = { entry, home: homeOf(entry), ids: Object.keys(files), sizes: new Map(all.map((f) => [f.id, f.size])), stamps };
    Object.assign(this.wanted, { entry, scenario: null, names: null });
    step(this.steps, "building it, or taking it as it was last settled here");
    this.want("opened").then(() => idle(this.steps), (e) => { idle(this.steps); this.failed(e); });
  }
  /**
   * Has it built again where its files have changed in storage (looked at, at most, once a second; `now`: at once, as by whoever
   * has just changed one). `force`: whether they changed or not. Where it is built again, `{ built }`: answered when it is (which
   * is not waited for here). Files read again that are as it was built of build nothing (`buildOnce`: the same key).
   */
  refresh(force = false, now = force) { return (this.looking = this.looking.catch(() => {}).then(() => this.refreshNow(force, now))); }
  async refreshNow(force, soon) {
    const o = this.open;
    if (!o?.stamps) return;
    const t = Date.now();
    if (!soon && t - this.lastCheck < 900) return;
    this.lastCheck = t;
    if (!force) {
      const stamps = await storage.store.stat(watched(o));
      const other = watched(o).filter((id) => stamps[id] !== o.stamps[id]);
      if (tracing("build")) trace("build", { entry: this.entry, looked: watched(o).length, changed: other });
      if (!other.length) return;
    }
    const built = this.want(force ? "asked again" : "its files changed");
    built.catch(() => {});
    return { built };
  }

  // ----- its model, as built ---------------------------------------------------------------------

  /** Asks the engine for its state, and says what changed: one asking at a time. */
  look() {
    return (this.looked = (this.looked ?? Promise.resolve()).catch(() => {}).then(async () => {
      // (Its state, asked of the engine only where it is of another build than the one had: saying it is not nothing. Not while
      // its script does not build: what was said of that stands, till it builds.)
      if (this.broken != null) return;
      if (this.state?.file && (await this.engine("version")) === this.state.version) return;
      if (!this.state?.file) step(this.steps, "asking for the model's state");
      let s = await this.engine("state");
      // (Nothing built yet, nor shown as kept: nothing to say.)
      if (!s) return;
      if (s.file && !this.state?.file) step(this.steps, "showing the model");
      if (!this.state || s.version !== this.state.version) {
        const was = this.state;
        // (Its sheets, drawn again after it is built again: those of before are listed meanwhile, so that what is
        // listed under them does not jump up and back under the pointer.)
        if (was && s.file === was.file && s.drawn === false && !s.sheets?.length && was.sheets?.length) s = { ...s, sheets: was.sheets };
        this.state = s;
        if (s.file) reached("state");
        // (Its sheets drawn already for what shows them, of the build before: drawn again, of this one.)
        if (s.drawn === false && was?.drawn) this.draw();
        await this.said(s, was);
        // (Where its bodies meet, of the root part focused, once nothing else is being done.)
        if (this.focused && s.file && !s.error) whenIdle(() => this.clashes());
      }
    }));
  }
  /** Its state is another: said to whoever listens to it, and, focused, to whoever listens to the page's model. (Each is told at
   *  once, and none waits for another to be done with it: the 3D view asks for its parts while the files are read. The next
   *  look at the engine waits for them all.) */
  said(s, was) {
    return Promise.all([...this.listeners, ...(this.focused ? model.listeners : [])].map(async (f) => f(s, was)));
  }
  /** `f(state, was)` whenever it is built again, focused or not. */
  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  /** Its build failed (not the script: the engine, as it was asked): said as its state. */
  failed(e) {
    const was = this.state, s = { version: -1, file: this.entry, error: `it could not be built: ${e?.message ?? e}` };
    this.state = s;
    this.said(s, was);
  }
  /** Whether a change to it is being built, or waits to be. */
  get busy() { return this.builds.busy; }
  /** Whether it is built (its script ran). */
  get built() { return !!this.state && !this.state.error && !this.state.opening; }
  /** What checking found apart, of the build its state is of; none, where its checks are said with it (or are not found yet). */
  get checksSaid() { return this.checks && this.checks.version === this.state?.version ? this.checks.said : null; }
  /**
   * Has its sheets drawn (by the engine that draws them), and says so when they are: of the build its state is
   * of, and no other. One drawing at a time: built again meanwhile, however often, it is drawn once more when
   * this is done, as it then is (the builds between are not drawn at all).
   */
  async draw() {
    // (Asked again while they are drawn: drawn once more only where it is of another build.)
    if (this.drawing) return void (this.drawingOf !== this.state?.version && (this.drawAgain = true));
    this.drawing = true;
    try {
      do {
        this.drawAgain = false;
        this.drawingOf = this.state?.version;
        // (From its sheets as last drawn, where they are of this build; else drawn, and kept.)
        const file = this.open ? await answered(() => this.background("drawnFile")).catch(() => null) : null;
        const kept = file ? await cacheOf(storage).get(keptIdOf(this.entry, file)) : null;
        const d = await answered(() => this.background("drawn", { kept }));
        if (d.keep) cacheOf(storage).set(keptIdOf(this.entry, d.keep.id), d.keep.text);
        if (d.error || d.version !== this.state?.version || this.state.drawn) continue;
        this.state = { ...this.state, sheets: d.sheets, sheet_errors: d.sheet_errors, drawn: true };
        if (this.focused) for (const f of model.drawnListeners) await f(this.state);
        reached("sheets");
      } while (this.drawAgain);
    } finally {
      this.drawing = false;
    }
  }
  /**
   * Asks something of the model as built: "sheet" (a drawing, as SVG), "member", "ratios", "deflected" (fettled-app's
   * requests, with their arguments).
   */
  ask(what, args) { return answered(() => (OF_BACKGROUND.has(what) ? this.background("request", { op: what, args }) : this.engine("request", { op: what, args }))); }
  /** Its structure carried down and checked (the `analysis` product: `{ analysis, loads, issues }`), of the build its state is of,
   *  the load cases its checks leave out left out: made once for each, when first asked for. */
  analysis() {
    const version = this.state?.version;
    if (!this.analysed || this.analysed.version !== version) this.analysed = { version, made: this.built ? this.ask("analysis") : Promise.resolve({ error: this.state?.error ?? "it is not built" }) };
    return this.analysed.made.then((a) => {
      if (this.analysed?.version !== version || a.error || this.analysed.said) return a;
      this.analysed.said = a;
      if (this.focused) for (const f of model.analysedListeners) f(a);
      return a;
    });
  }
  /** What of its analysis is had already, of the build its state is of (none: not asked for, or not yet made). */
  get analysisSaid() { return this.analysed && this.analysed.version === this.state?.version ? this.analysed.said ?? null : null; }
  /**
   * How it is made (docs/build-plans.md): the plans script beside it (`<model>.plans.ts`), evaluated beside it:
   * `{ file, tree }` (the tree as written, each leaf with the parts it makes, and every part); `{ file, none: true }`
   * where there is none; `{ file, error }` where it does not evaluate.
   */
  plans() {
    return answered(async () => {
      const file = this.entry.replace(/\.ts$/, ".plans.ts");
      const text = await storage.store.read(file).catch(() => null);
      if (text == null) return { file, none: true };
      try { return { file, tree: await this.engine("plans", { file, text }) }; } catch (e) { return { file, error: String(e?.message ?? e) }; }
    });
  }
  /** Its parts as solids (`{ members, stats, structure }`), made once for each build; with its fastenings among them,
   *  where they are shown (`filters.js`). */
  parts() {
    const version = this.state?.version, fixings = showsFixings();
    if (!this.mesh || this.mesh.version !== version || this.mesh.fixings !== fixings) {
      const made = this.built ? this.ask("mesh") : Promise.resolve({ error: this.state?.error ?? "no project is open" });
      this.mesh = { version, fixings, made: fixings && this.built ? Promise.all([made, this.fastenings()]).then(([m, f]) => (m.error || !f.parts.length ? m : { ...m, members: [...m.members, ...f.parts] })) : made };
    }
    return this.mesh.made;
  }
  /** Its parts' exact bodies, as `bodies` has them; with its fastenings', where they are shown. */
  async bodies() {
    const [bodies, f] = await Promise.all([this.ask("bodies"), showsFixings() ? this.fastenings() : null]);
    return f?.bodies?.length && Array.isArray(bodies) ? [...bodies, ...f.bodies] : bodies;
  }
  /** Its fastenings drawn (`{ parts, bodies }`: each nail its nailings lay out), made once for each build; none where
   *  the engine cannot say them. */
  fastenings() {
    const version = this.state?.version;
    if (!this.fixed || this.fixed.version !== version) this.fixed = { version, made: this.ask("fastenings").catch((e) => (console.warn("fastenings:", e), { parts: [], bodies: [] })) };
    return this.fixed.made;
  }
  /**
   * Its parts as they would be with these files (by id, each its text) in place of the project's own: built
   * aside, the model that is open left as it is. A proposal's side, which is every part of it and not its members alone.
   */
  partsWith(files) { return answered(async () => this.solverEngine()("meshOf", { entry: this.entry, files: (await this.gather(files)).files })); }
  /** Builds it for a scenario of its script's (by name). */
  scenario(name) { return answered(() => { this.wanted.scenario = name; return this.want("its scenario"); }); }
  /** Its checks without these load cases (by name): made again of the model as it is (nothing is built, nothing else is made
   *  again), and said to whoever shows them; its sheets, where they are drawn (they show its ratios), drawn again. */
  exclude(names) {
    return answered(async () => {
      // (The background engine, which makes its checks, is told as it is next asked: `background`.)
      this.wanted.names = names;
      this.analysed = null;
      if (this.state?.drawn) { this.state = { ...this.state, drawn: false }; this.draw(); }
      await this.analysis();
      return this.state?.version;
    });
  }
  /** What it writes kept, and it built again with that: `{ built }` of `refresh`. */
  async keepAll(ws) {
    for (const w of ws) await this.keepOf(w);
    return ws.length ? await (await this.refresh(true))?.built : undefined;
  }
  /** Of a part script: keeps params beside it (`{ address: { value, tier } }`, from its root: a tier as the engine has
   *  it, `"must"`, `{ at: { level, within } }` or `"start"` (free), held where none is said; null lets one go); it is
   *  built again. `{ file }`. */
  params(params, { scratch: tried = false } = {}) {
    return answered(async () => { const w = await this.script("partParams", { params, scratch: tried }); await this.keepAll([w]); return { file: w.id }; });
  }
  /** Of a part script: entries let go of (by their keys: `param ADDRESS`, a drag's key), wherever a person has them: in their
   *  layer, or tried out. It is built again. `{ files }`. */
  letGo(keys) {
    return answered(async () => { const ws = await this.script("partLetGo", { keys }); await this.keepAll(ws); return { files: ws.map((w) => w.id) }; });
  }
  /** Of a part script: what is tried out (by keys; none: all of it) kept in your layer (in a session, everyone's), as firmly
   *  as `tier` says (as the engine has it; none: as it was tried); let go of from what is tried out. It is built again. */
  keepScratch(keys = null, tier = null) {
    return answered(async () => {
      if (!this.scratch.on) throw new Error("what is tried out is turned off: turn it on to keep it");
      const ws = await this.script("partKeepScratch", { keys, tier });
      for (const w of ws) await this.keepOf(w);
      await (await this.refresh(true))?.built;
      return { files: ws.map((w) => w.id) };
    });
  }
  /** What is tried out let go of, all of it (undoable); built again as the model is. */
  clearScratch() { return answered(async () => { this.setScratch(null); await (await this.refresh(true))?.built; return {}; }); }
  /** What is tried out built in, or not (`on`), to compare: built again. */
  scratchOn(on) { return answered(async () => { this.scratch.on = !!on; this.saidScratch(); await (await this.refresh(true))?.built; return {}; }); }
  /** The last change to what is tried out undone (`redo`: the last undone, made again); built again. */
  scratchStep(redo = false) {
    return answered(async () => {
      const s = this.scratch, [from, to] = redo ? [s.ahead, s.back] : [s.back, s.ahead];
      if (!from.length) return {};
      to.push(s.text);
      this.setScratch(from.pop(), false);
      s.on = true;
      this.saidScratch();
      await (await this.refresh(true))?.built;
      return {};
    });
  }
  /** Of a part script: entries of your layer (docs/layers.md; by their keys: `param ADDRESS`, a drag's key; none:
   *  all of yours) kept for everyone, moved into the model's own generated file; it is built again. `{ files }`. */
  share(keys) {
    return answered(async () => {
      const ws = await this.script("partShare", { keys });
      for (const w of ws) await this.keepOf(w);
      await (await this.refresh(true))?.built;
      return { files: ws.map((w) => w.id) };
    });
  }
  /** Of a part script: one of its scene's tools (fettled-scene's, as a host has them: slabs, polylines, planes, selections, views, what
   *  is scratch, and a scan's, where it has one and it is read), by `who`. What it writes is kept, and the model built again with it.
   *  `{ content, isError, written }`. `page`: `{ names, shared }`, who people are called and whether others make things here at once. */
  sceneCall(who, tool, args, page, land = true) {
    return answered(async () => {
      const r = await this.engine("sceneCall", { who, tool, args, page, land });
      await this.keepScenes();
      for (const w of r.written ?? []) if (w.text != null) await this.keepOf(w);
      if (r.written?.length) await (await this.refresh(true))?.built;
      return r;
    });
  }
  /** Its scene's scans read on, a slice at a time (`fettled_scene::reading`): how far the read has come; null where there is none to
   *  read, or it will not be. */
  async sceneRead(page) { const p = await this.engine("sceneRead", { page }).catch(() => null); await this.keepScenes(); return p; }
  /** What its scene says of itself (fettled-scene's `Scene::state_json`); null where it is not a part script. */
  async sceneState(page) { const s = await this.engine("sceneState", { page }).catch(() => null); await this.keepScenes(); return s; }
  /** What a viewer asks of its scene as it draws (`fettled_scene::drawn`): an `ArrayBuffer` (points), or what it says (of `rays`,
   *  `pick`, `evidence`, `select`), as the engine answers: bytes, or JSON as a string. Null where it cannot be (said in the console). */
  async sceneDraw(what, args, page) {
    try {
      const b = await this.engine("sceneDraw", { what, args, page });
      await this.keepScenes();
      return typeof b === "string" ? JSON.parse(b) : b.buffer;
    } catch (e) {
      console.warn(`the scene's ${what}: ${e?.message ?? e}`);
      return null;
    }
  }
  /** The tools its scene has, as MCP lists them: `[{ name, description, inputSchema }]`. */
  sceneTools() { return this.engine("sceneTools", {}); }
  /** Its scene's scans, each given to the engine to read by its ranges from where it is kept: whether every one is there. */
  async scenePoints(page) {
    const ids = await this.engine("scenePoints", { page }).catch(() => []);
    let all = true;
    for (const id of ids) {
      const source = await storage.store.bytes?.(id).catch(() => null);
      all = all && !!source && (await this.engine("sceneReader", { id, source }));
    }
    // (And what the app keeps of them, where it has: a scan's layout, read in part where the scan is too big to read whole.)
    for (const id of await this.engine("sceneKept", { page }).catch(() => [])) {
      const source = await cacheOf(storage).bytes(id);
      if (source) await this.engine("sceneReader", { id, source });
    }
    return all;
  }
  /** Of a part script: keeps these drags beside it (all of them, as `params` answers them: `{ what, from, to, tier }`),
   *  in place of those kept; it is built again. `{ file }`. */
  drags(drags, { scratch: tried = false } = {}) {
    return answered(async () => { const w = await this.script("partDrags", { drags, scratch: tried }); await this.keepAll([w]); return { file: w.id }; });
  }
  /** Of a part script: keeps a reading beside it by `name` (`{what, within}`: what was read, by addresses from its
   *  root, and to within how much), or lets the one of that name go (`reading` none); it is built again. `{ file }`. */
  read(name, reading) {
    return answered(async () => { const w = await this.script("partReading", { name, reading }); await this.keepAll([w]); return { file: w.id }; });
  }
  /** Of a part script, as a person drags: what is grabbed (`{ node }`, by address from its root; `{ point: { part,
   *  at } }`, a part by a point of it; `{ face: { part, at, normal } }`, a face pushed and pulled; each where it was
   *  grabbed, in the root's frame) on the cursor's ray, from `from` toward `to` (millimetres, the root's frame), at the
   *  level dragged, with what is kept (in place of a drag kept of the same thing, or `beside` it): `{ bodies, params }`
   *  as they then are, or `{ error }`. Nothing is kept or built again. */
  grab(what, from, to, beside = false) { return this.held("partGrab", { what, from, to, beside }); }
  /** Of a part script, as a param's value is dragged across in the Params panel: the param at `address` (from its
   *  root) at `value`, as firmly as `tier` says (as the engine has it; held where none is), in place of what is kept
   *  of it: `{ bodies, params }` as they then are, or `{ error }`. Nothing is kept or built again; let go of as a drag
   *  is (`grabEnd(false)`), and kept by `params`. */
  paramDrag(address, value, tier) { return this.held("partParamDrag", { address, value, tier }); }
  /** A move of a drag (`op`), of its solver: held by it from now till it is let go of (`grabEnd`). */
  held(op, args) { return this.script(op, args, { hold: true }).catch((e) => ({ error: e.message ?? String(e) })); }
  /** Of a part script as built: what must hold that the param at `address` is of (a list, each by what says it): what
   *  decides it, where what must hold does; or `{ error }`. */
  mustsOf(address) { return this.script("partMustsOf", { address }).catch((e) => ({ error: e.message ?? String(e) })); }
  /** Of a part script as built: how the node at `address` can move with all that must hold held: `{ rank, dirs,
   *  params }`, or `{ error }`. */
  ways(address) { return this.script("partWays", { address }).catch((e) => ({ error: e.message ?? String(e) })); }
  /** Of a part script: a drag let go of; the next begins from the part as built. Kept (`keep`): the drag as it last was
   *  is kept beside it, and it is built again: `{ file, drags }` (the drags kept before it, to undo it), or `{}` where
   *  nothing was dragged. */
  grabEnd(keep, { scratch: tried = false } = {}) {
    return answered(async () => {
      let w;
      try { w = await this.script("partGrabEnd", { keep, scratch: tried }); } finally { this.builds.release(); }
      if (!w) return {};
      await this.keepAll([w]);
      return { file: w.id, drags: w.drags };
    });
  }
}

/** The workspace's files listed (again), for every root part: where one more or fewer, or one changed, whoever shows them is
 *  told. (Looked at less often than whether what a model is built from has changed.) */
function listAgain(force) {
  return (listing = listing.catch(() => {}).then(async () => {
    const now = Date.now(), home = homeOf(opened ?? "");
    if (!opened || (!force && now - listed.at < 4000)) return;
    const all = await inWorkspace(home), sign = signOf(all), other = sign !== listed.sign;
    listed = { all, at: now, sign };
    for (const r of roots.values()) if (r.open) r.open.sizes = new Map(all.map((f) => [f.id, f.size]));
    if (other) for (const f of project.fileListeners) f();
  }));
}

/** Whether a script is opened as a model: it exports one, or a part (which is a model of itself); not a plans script. */
export const isModelScript = (text) => /export\s+default|export\s+const\s+\w+\s*=\s*part\(\{/.test(text) && !/export\s+default\s+plans\(/.test(text);
const isModel = new Map(); // a store's label and a file's id → { mtime, model: whether it is a project's model }
/** When a file was changed (ms since 1970), as a store says it: a time; or, served, its ETag (`"nanoseconds-length"`). */
const timeOf = (mtime) => (typeof mtime === "number" ? mtime : +(/^"?(\d+)-/.exec(String(mtime))?.[1] ?? 0) / 1e6);
/**
 * The root parts in a store, by workspace: each folder that has a `model.ts` (that is what is opened of it), and each file
 * elsewhere that is a model (it has a default export) or a part, by itself. `workspace`: its workspace's name; `group`: the
 * folder in the workspace it is in ("": the workspace's own).
 */
async function projects(store) {
  const out = [], all = await store.list(), known = (f) => `${store.label}\n${f.id}`;
  const folders = all.map((f) => folderOf(f.id)).filter((d) => d != null);
  // (A folder with a `model.ts`: that is what is opened of it, and the rest of it is what it is made of, each of which can be opened as the root from there.)
  const mine = (f) => folderOf(f.id), within_another = (f) => folders.some((d) => d !== mine(f) && within(f.id, d));
  // (What is kept beside a model is not a root part: its readings, its plans, its sightings, and what is made for it.)
  const beside = /\.(measured|plans|sightings)\.ts$|\.gen\.ts$/;
  const alone = all.filter((f) => !beside.test(f.id) && !within_another(f));
  // (Whether a file by itself is a model is read of its text, where the listing does not say: all of them at once.)
  await Promise.all(alone.filter((f) => mine(f) == null && isModel.get(known(f))?.mtime !== f.mtime).map(async (f) => {
    isModel.set(known(f), { mtime: f.mtime, model: f.project ?? isModelScript((await store.read(f.id)) ?? "") });
  }));
  // (When it was last changed: the latest of its folder's files; of a model by itself, of it and what is kept beside it.)
  const latest = (of) => Math.max(0, ...all.filter(of).map((f) => timeOf(f.mtime)));
  // (The folder in its workspace something is in.)
  const groupOf = (id) => pathIn(dirOf(id));
  for (const f of alone) {
    const workspace = workspaceOf(f.id);
    if (mine(f) != null) {
      // (A workspace's own model is called by the workspace's name.)
      const folder = pathIn(mine(f));
      out.push({ workspace, group: folder ? groupOf(mine(f)) : "", name: folder ? nameOf(mine(f)) : workspace, path: f.id, changed: latest((g) => within(g.id, mine(f))) });
      continue;
    }
    if (!isModel.get(known(f))?.model) continue;
    const stem = f.id.replace(/\.ts$/, "");
    out.push({ workspace, group: groupOf(f.id), name: nameOf(f.id).replace(/\.ts$/, ""), path: f.id, changed: latest((g) => g.id === f.id || g.id.startsWith(`${stem}.`)) });
  }
  return out.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

/** Who hears of another root part being focused (`f(root)`), before the page's model is said to be it; and of one closed. */
const focusListeners = [], closeListeners = [];

export const project = {
  /**
   * Opens a root part of the page's workspace (by its file's id among the files), where it is not open: the first, as the
   * page is loaded (the page is of its workspace from then: another workspace is gone to by loading the page again with it,
   * `go`); any other of the workspace, as a view is turned to it, kept for as long as the page is. `{ remember: false }`: one
   * looked at as it was at a commit, which is not among those opened last. `{}`, or `{ error }` (nothing is then open of it).
   * The first is focused at once; another, when a view of it is used (`focus`).
   */
  open: (entry, { remember = true } = {}) => answered(async () => {
    if (roots.has(entry)) return {};
    if (opened && homeOf(entry) !== homeOf(opened)) throw new Error(`${entry} is not of this page's workspace: go to it (project.go)`);
    const first = !opened;
    if (first) { opened = entry; began(entry); }
    const name = nameOf(entry).replace(/\.ts$/, "");
    const also = spare ? "" : ` · ${name}`;
    const r = new Root(entry, spare ?? engine("model", `model${also}`), also);
    spare = null;
    roots.set(entry, r);
    // (One opened beside the first: said to be opening, at once, so that it can be focused and shown as that while its files are
    // read and its model is built or taken as it was kept.)
    if (!first) r.state = { version: ++builds, file: entry, opening: true, issues: [], sheets: [], drawn: true, scenarios: null };
    try {
      // Its files, as they are listed where it is kept, said at once: they can be looked at while it is built (which
      // files it is built from is known once they are read, and the engine has said what each imports).
      if (first) {
        step("page", "listing its files");
        const home = homeOf(entry), all = await inWorkspace(home);
        listed = { all, at: Date.now(), sign: signOf(all) };
        const ids = [entry, ...all.map((f) => f.id).filter((id) => id !== entry)];
        for (const f of project.listedListeners) f({ entry, home, ids });
        focused = r;
      }
      // (Among those opened last as soon as it is had: its model may take a while to build.)
      if (first && remember) {
        const at = { in: storage.kind, path: entry }, was = (await settings.get(RECENT_KEY).catch(() => null)) ?? [];
        // (Not a session shared over the internet: it is at a link, and nowhere else.)
        if (storage.kind !== RELAYED) settings.set(RECENT_KEY, [at, ...was.filter((x) => x.in !== at.in || x.path !== at.path)].slice(0, RECENT)).catch(() => {});
        project.sayInAddress(entry);
      }
      await r.openFiles();
      return {};
    } catch (e) {
      roots.delete(r.entry);
      if (first) { opened = null; focused = null; }
      step(r.steps, `could not open it: ${e?.message ?? e}`);
      idle(r.steps);
      throw e;
    }
  }),
  /** The address says the root part focused, so that the page loaded again opens it first (its hash and its location kept). */
  sayInAddress(entry) {
    if (!entry) return;
    const u = new URL(project.href(entry, storage.kind)), at = new URLSearchParams(location.search).get("at");
    if (at) u.searchParams.set("at", at);
    u.hash = location.hash;
    if (u.href !== location.href) history.replaceState(history.state, "", u.href);
  },
  listedListeners: [],
  /** `f({ entry, home, ids })` as soon as the files of the workspace of the part being opened are listed (before anything is read,
   *  and before its model is built): those files, the part's first; `home`: the folder they are all in. */
  onListed(f) {
    this.listedListeners.push(f);
  },
  /** A root part open (by its id), or none. */
  root: (entry) => roots.get(entry) ?? null,
  /** The root parts open, the page's first first. */
  roots: () => [...roots.values()],
  /** The root part focused, or none. */
  focusedRoot: () => focused,
  /**
   * Focuses a root part open (by its id): what the page shows of a model besides its 3D views is of it from now. Nothing of it
   * is built again: it is as it was left. Whoever listens for the page's model hears of it as of another model.
   */
  focus(entry) {
    const r = roots.get(entry);
    if (!r || r === focused) return;
    const wasRoot = focused, was = wasRoot?.state ?? null;
    focused = r;
    project.sayInAddress(entry);
    for (const f of focusListeners) f(r, wasRoot);
    if (r.state) for (const f of model.listeners) f(r.state, was);
    for (const f of model.solvingListeners) f(r.solving);
    if (r.checks) for (const f of model.checkedListeners) f(r.checks);
    for (const f of scratchListeners) f();
  },
  /** `f(root, was)` when another root part is focused, before the page's model is said to be it. */
  onFocus(f) { focusListeners.push(f); },
  /**
   * Closes a root part open (by its id), where it is not the only one: another is focused where it was; its engines are ended,
   * the background engine lets go of its model, and whoever keeps something of it is told (`onClose`) to let go of that.
   * (What is kept of it in this browser, as it was settled and drawn, stays: it opens again from that.) Whether it was.
   */
  close(entry) {
    const r = roots.get(entry);
    if (!r || roots.size < 2) return false;
    if (focused === r) project.focus([...roots.keys()].find((e) => e !== entry));
    roots.delete(entry);
    for (const e of [r.reader, r.solver].filter(Boolean)) { e.stop(); all.delete(e); }
    if (r.key && handed.delete(r.key)) background?.("drop", { key: r.key }).catch(() => {});
    for (const f of closeListeners) f(r);
    return true;
  },
  /** `f(root)` when a root part is closed: what is kept of it is let go of. */
  onClose(f) { closeListeners.push(f); },
  /** The root part focused (its model's id among the files), or none. */
  current: () => focused?.entry ?? null,
  /** The root part the page is of: focused, or being opened (its model may take a while to build); or none. */
  ofPage: () => focused?.entry ?? opened,
  /** The workspace the page is of (the start of its ids, `W:`), or none. */
  home: () => (opened ? homeOf(opened) : null),
  /** The projects in a location (as `storage.locations` has it, one it can use now): `{ projects: [{ group, name,
   *  path, changed }] }` (`changed`: when it last was, ms since 1970; 0: not known), or `{ error }`. */
  listIn: (kind) => answered(async () => {
    const store = storage.of(kind);
    if (!store) throw new Error("it cannot be used now");
    return { projects: await projects(store) };
  }),
  /** The projects opened here last, the latest first: `[{ in, path }]` (`in`: the location it is in). */
  recent: async () => (await settings.get(RECENT_KEY).catch(() => null)) ?? [],
  /** Whether a file is too large to be read to be shown. */
  tooBig: (id) => (listed.all?.find((f) => f.id === id)?.size ?? 0) > TOO_BIG,
  /** The page's address with a root part open in it, by its id (`W:path`), in a location (the host's, unless said):
   *  `?workspace=W&part=path` (docs/workspaces.md). None: the workspaces page, nothing open. */
  href(entry, kind = "host") {
    const u = new URL(location.href), q = new URLSearchParams();
    if (entry) {
      if (kind !== "host") q.set("in", kind);
      q.set("workspace", workspaceOf(entry) ?? "");
      q.set("part", pathIn(entry));
    }
    u.search = q.toString() ? `?${q}` : "";
    u.hash = "";
    return u.toString();
  },
  /** What an address names: `{ entry }`, the root part's id (null: none). */
  inAddress(href) {
    const q = new URL(href).searchParams, w = q.get("workspace"), p = q.get("part");
    return { entry: w && p && WORKSPACE_NAME.test(w) ? idOf(w, p) : null };
  },
  /** Waits till what is being written of the open project is written: the page can then be left. */
  leave: async () => {
    await Promise.allSettled([...roots.values()].map((r) => r.looking.catch(() => {})));
    await Promise.allSettled([...writing]);
  },
  /** Goes to another project (as `href`): the page is loaded again with it, once what is being written is written;
   *  nothing of the one open is left. (Whoever asks has asked about edits not saved.) */
  async go(path, kind) {
    await project.leave();
    location.assign(project.href(path, kind));
  },
  /** Whether new workspaces are made in a location: by a host told where; in this browser, which keeps any number. */
  makesWorkspaces(kind) {
    const store = storage.of(kind);
    return kind === "browser" ? !!store : !!store?.makesWorkspaces;
  },
  /** Makes a workspace of this name in a location, with its model (`model.ts`): on a host, the host makes it (a git repository, its
   *  model in its first commit); in this browser, the page. `{ file }`: its model's id, to go to. */
  createWorkspace: (name, kind) => answered(async () => {
    if (!name.trim()) throw new Error("give the workspace a name");
    if (!project.makesWorkspaces(kind)) throw new Error("no workspaces are made there");
    const store = storage.of(kind);
    if (kind !== "browser") return { file: (await store.createWorkspace(name.trim())).part };
    const { slug, text } = await anyEngine()("newWorkspace", { name: name.trim() });
    if (!slug) throw new Error("a workspace's name needs a letter or a digit in it");
    if ((await store.list()).some((f) => workspaceOf(f.id) === slug)) throw new Error(`there is already a workspace ${slug} there`);
    const id = idOf(slug, MODEL);
    await store.write(id, text);
    return { file: id };
  }),
  /**
   * Copies a workspace (by its name, in a location) to a new one of one's own, `name`, in `to` ("browser", or "host" where
   * it makes workspaces): its text files as that location has them (edits kept over it included). `{ workspace, skipped }`:
   * the copy's name, and the files not copied (not text).
   */
  copyWorkspace: (kind, workspace, name, to) => answered(async () => {
    const from = storage.of(kind);
    if (!from) throw new Error("it cannot be read now");
    if (!name.trim()) throw new Error("give the copy a name");
    const ids = (await (from.all?.() ?? from.list())).map((f) => f.id).filter((id) => workspaceOf(id) === workspace && !LOCAL_ONLY.test(id));
    let slug;
    if (to === "browser") {
      slug = workspaceName(name.trim());
      if ((await storage.of("browser").list()).some((f) => workspaceOf(f.id) === slug)) throw new Error(`there is already a workspace ${slug} in this browser`);
    } else if (to === "host") {
      if (!project.makesWorkspaces("host")) throw new Error("this host makes no workspaces");
      const made = await storage.of("host").createWorkspace(name.trim());
      slug = made.workspace ?? workspaceOf(made.part);
    } else throw new Error(`no copy is made in ${to}`);
    const dest = storage.of(to), skipped = ids.filter((x) => NOT_TEXT.test(x)), next = ids.filter((x) => !NOT_TEXT.test(x))[Symbol.iterator]();
    // (On a host each file written is a commit of its own: one at a time.)
    await Promise.all(Array.from({ length: to === "host" ? 1 : COPYING_AT_ONCE }, async () => {
      for (let n = next.next(); !n.done; n = next.next()) {
        const text = await from.read(n.value);
        // (Read as text, but not: bytes that are no text, which are left as pictures are.)
        if (text == null) continue;
        if (text.includes("\uFFFD")) { skipped.push(n.value); continue; }
        await dest.write(idOf(slug, pathIn(n.value)), text);
      }
    }));
    return { workspace: slug, skipped: skipped.map(pathIn).sort() };
  }),
  /** The files of a workspace (by its name, in a location) edited here over what it has (none where it keeps none). */
  editsIn: async (kind, workspace) => ((await storage.of(kind)?.edits?.().catch(() => [])) ?? []).filter((id) => workspaceOf(id) === workspace),
  /** Lets those go: it is then as its location has it. */
  discardEdits: (kind, workspace) => answered(async () => {
    const store = storage.of(kind);
    for (const id of await project.editsIn(kind, workspace)) await store.top.remove(id);
    store.said?.();
    return {};
  }),
  /** Makes a file in the page's workspace, by its path in it (a script: as a new model begins, named by its file), and lists
   *  it. `{ file }`: its id. (Whether it is a part is what its script says, as of any file.) */
  createFile: (path) => answered(async () => {
    const home = project.home(), store = storage.store;
    if (!home || !store?.writable) throw new Error("no file can be made here now");
    const id = idOf(workspaceOf(home), path);
    if ((await store.read(id)) != null) throw new Error(`${path} already exists`);
    // (A script begins as a new workspace's model does, the engine's: one plate, named by its file.)
    const text = path.endsWith(".ts") ? (await anyEngine()("newWorkspace", { name: nameOf(path).replace(/\.ts$/, "") })).text : "";
    await store.write(id, text);
    await project.touched();
    return { file: id };
  }),
  /**
   * The workspace's files: `{ files: [{ path, name, text, built }] }`, the root part focused first (`name`: from the workspace's folder;
   * `built`: its model is built from it). Only what it is built from has its text: there may be any number of the rest, each read
   * when it is opened.
   */
  sources: () => answered(async () => {
    const o = focused?.open;
    if (!o) throw new Error("no model open");
    const files = [], prefix = o.home, built = o.ids;
    const ids = [...new Set([...built, ...(listed.all ?? []).map((f) => f.id)])].sort((a, b) => (b === o.entry) - (a === o.entry) || a.localeCompare(b));
    const texts = await Promise.all(ids.map((id) => (built.includes(id) ? storage.store.read(id) : null)));
    ids.forEach((id, k) => files.push({ path: id, name: id.startsWith(prefix) ? id.slice(prefix.length) : id, text: texts[k] ?? "", built: built.includes(id) }));
    return { files };
  }),
  fileListeners: [],
  /** `f()` when the workspace's files have changed (one more, one fewer, one edited elsewhere). */
  onFiles(f) {
    this.fileListeners.push(f);
  },
  /** Saves one of the workspace's files; every model built from it is built again: `{ model_error }` (why the focused one does not
   *  build, if it does not). */
  save: (path, text) => answered(async () => {
    const home = project.home();
    if (!home || !within(path, home)) throw new Error(`${path} is not one of this workspace's files`);
    await storage.store.write(path, text);
    const again = [...roots.values()].map((r) => r.refresh(r.open?.ids.includes(path), true));
    await Promise.all(again.map(async (p) => (await p)?.built));
    listAgain(true);
    return { model_error: focused ? (await focused.engine("state")).error ?? null : null };
  }),
  /** One of its files has just been written here: it is looked at now, not when the files are next looked at, and the models built
   *  from it built again (which is not waited for). */
  touched: () => answered(async () => { await Promise.all([...roots.values()].map((r) => r.refresh(false, true))); listAgain(false); return {}; }),
  /** The focused root part built again from its files alone: what was kept of settles of it (by their keys, here or on the host)
   *  not taken this once, and the part as last settled, kept in this browser, forgotten; so each free value starts where its
   *  script says. */
  rebuildFresh: () => answered(async () => {
    const r = focused;
    if (!r?.open) return {};
    r.fresh = true;
    await forgetSettled(settledId(r.entry));
    return { built: (await r.refresh(true))?.built };
  }),
};

// ----- the model: the root part focused, as the engine has built it -----------------------------------

/** What the page's model answers with no root part open. */
const NONE = { version: -1, file: "", error: "No project is open: choose one, or make one, on the projects page." };
/** What is the page's own of the model: who listens to it (whichever root part is focused), and what looks at them all. */
const page = {
  listeners: [],
  /** (Whether it has been said that no root part is open, and the saying of it.) */
  noneSaid: false,
  lookedNone: null,
  /** `f(state, was)` whenever another root part is focused, or the focused one has been built again. */
  onChange(f) { this.listeners.push(f); },
  drawnListeners: [],
  /** `f(state)` when the sheets of the model as built have been drawn: they are in its state from then (`sheets`), not before. */
  onDrawn(f) { this.drawnListeners.push(f); },
  brokenListeners: [],
  /** `f(error)` when one of its engines could not be started (its scripts not loaded, tried again and again): what is asked of
   *  that one fails from then, saying so. */
  onBroken(f) { this.brokenListeners.push(f); },
  checkedListeners: [],
  /** `f(checks)` when checking a build of it apart has found what is wrong with it. */
  onChecked(f) { this.checkedListeners.push(f); },
  solvingListeners: [],
  /** `f(solving)` whenever how far its build has come changes. */
  onSolving(f) { this.solvingListeners.push(f); },
  analysedListeners: [],
  /** `f({ analysis, loads, issues })` when its structure has been carried down and checked (asked for by what shows it). */
  onAnalysed(f) { this.analysedListeners.push(f); },
  /** Asks its engine for its state, and says what changed (with none open: that none is). */
  look() {
    if (focused) return focused.look();
    return (page.lookedNone ??= Promise.resolve().then(() => {
      // (One being opened meanwhile: it is said, not that none is.)
      if (roots.size) return void (page.lookedNone = null);
      page.noneSaid = true;
      for (const f of page.listeners) f(NONE, null);
    }));
  },
  /** Follows what changes (the workspace's files, and so each model built from them), and says so; `failed(e)` when looking
   *  does. Told by the store as its files change (`watch`: the host's watcher, the folder's observer, this browser's other
   *  tabs), of whichever the page is using now; a store that cannot say its changes is looked at once a second instead. */
  watch(failed) {
    const look = async () => {
      try {
        await Promise.all([listAgain(true), ...[...roots.values()].map((r) => r.refresh(false, true))]);
        await Promise.all([...roots.values()].map((r) => r.look()));
        if (!roots.size) await page.look();
      } catch (e) {
        failed?.(e);
      }
    };
    let stop = null, polling = 0, following = null;
    // (Looked at once a second, till it is told of its changes again: by a generation, so a store left stops being looked at. A
    // store had first while it is looked at is followed from then.)
    const poll = (n) => {
      if (n !== polling) return;
      if (storage.store && storage.store !== following && storage.store.watch) return follow();
      look().finally(() => setTimeout(() => poll(n), 1000));
    };
    const follow = () => {
      stop?.();
      const n = ++polling;
      following = storage.store;
      stop = following?.watch?.(() => look(), () => { stop = null; poll(n); }) ?? null;
      if (!stop) poll(n);
      else look();
    };
    storage.onUse(follow);
    follow();
  },
};
/**
 * The page's model: that of the root part focused (`project.focus`). Whoever shows something of it listens for its changes, which are
 * also another root part being focused. (A 3D view that is of one root part asks it, not this: `project.root(entry)`.)
 */
export const model = new Proxy(page, {
  get(t, k) {
    if (k in t) return t[k];
    const r = focused;
    if (!r) {
      if (k === "state") return !roots.size && t.noneSaid ? NONE : null;
      if (k === "built" || k === "busy") return false;
      if (typeof Root.prototype[k] === "function") return async () => ({ error: "no model open" });
      return null;
    }
    const v = Reflect.get(r, k, r);
    return typeof v === "function" ? v.bind(r) : v;
  },
  set(t, k, v) {
    if (k in t) t[k] = v; else if (focused) focused[k] = v;
    return true;
  },
});
