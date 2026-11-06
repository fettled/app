// The open project, in the page: its files, wherever they are kept (store.js), and its model
// as the engine builds it from them (the engine: worker.js, off the page's thread).
//
//   storage   where projects are kept: which store, and choosing another
//   project   which project is open: listing them, going to another (the page is loaded again with it: nothing of
//             the one open is left), its files and saving them
//   model     the open project's model as built: its state (said again whenever it is built
//             again), its parts, and whatever else is asked of it (a sheet, a member's checks…);
//             and whether it is being built again (`solving`)
//
// Whatever is asked of the project or the model answers with what was asked for, or
// `{ error }`: nothing here throws at who asks.

import { WORKSPACE_NAME, dirOf, homeOf, idOf, nameOf, pathIn, within, workspaceOf } from "./ids.js";
import { GitHub } from "./github.js";
import { forgetGitObjects, BranchStore, BrowserStore, FolderStore, HttpStore, OverlayStore, githubBranch, githubPlace, keepGithub, readGithub, settings, tokenRefused } from "./store.js";
import { AtCommit, BranchWork, editsOf } from "./work.js";
import { auth } from "./auth.js";
import { EXAMPLES } from "./config.js";
import { scriptsBuild } from "./report.js";
import { asked, began, idle, reached, step } from "./times.js";
import { cacheOf } from "./cache.js";
import { keep as keepSettled, kept as keptSettled, keyOf } from "./settled.js";
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
    pending.set(id, { resolve, reject, sent, answered: asked(name, as ?? (op === "request" ? args.op : op)) });
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
  ask.stop = () => worker.terminate();
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
// Four of them. Two build: the model is asked of one (its state, its parts, a member's checks, what a ray meets), and
// what it is changed to (a file saved, a param held, another scenario) is built by the other while the first goes on
// answering, of the model as it was: a part of many parts takes seconds to settle, and nothing asked of the model waits
// for that. Built, the second is the one that is asked, and the first is told of the change, to build what comes next.
// A change made while one is built does not wait for it: what is being built is let go of (the engine started again),
// and what is asked by then is built.
const engines = [0, 1].map((k) => startEngine("model", `model ${"AB"[k]}`));
// And two solve nothing: the model as settled (data, handed out by the engine that built it) is what its sheets are
// drawn from, by the third, and what its checks find (where its bodies meet: seconds, of a model of many parts), by
// the fourth. Neither holds up the model, nor anything asked of it; each is let go of what it was doing where a model
// settled since is handed it.
const drawer = startEngine("sheets"), checker = startEngine("checks");
// (The page going: its engines ended with it, at once, and not when the browser gets to it, so that whatever it is going
// to, the page loaded again, say, does not wait behind a build of this one's.)
addEventListener("pagehide", () => { for (const e of [...engines, drawer, checker]) e.stop(); });
/** Which of the two the model is asked of: the other builds. */
let front = 0;
/** The model as last settled in this browser, shown from what is kept while it is built again (`{ version, key, bytes }`),
 *  and when that build is done (`real`: what needs the script waits for it). */
let shownKept = null, real = null;
/** What a model taken as it was settled (no script run here) can answer: the rest waits for it to be built. */
const VIEW = new Set(["state", "version", "request", "drawn", "partSolved", "partChecks", "partChecked", "imports", "newWorkspace", "settledOut", "stamp", "build", "renumber"]);
/** The files the model the engines answer of was built from. */
let asBuilt = {};
/** What an engine has made of the model, written (as made from the files it was built from: what others have changed since, in a session, stays);
 *  what is tried out (the scratch layer), kept by the page and never written. */
const keepOf = (w) => (isScratch(w.id) ? setScratch(w.text) : storage.store.write(w.id, w.text, { base: asBuilt[w.id] }));

/** What is tried out over the model (docs/layers.md: the scratch layer, over yours): the text of its layer file, which the
 *  page alone keeps (in this browser, for this model; never in the project, nor sent to others in a session); whether it
 *  is built in (`on`: off, the model is shown as it is without it, to compare); and its texts before (`back`) and after
 *  (`ahead`) each change, to undo and redo. */
export const scratch = { on: true, text: null, back: [], ahead: [], listeners: new Set() };
const isScratch = (id) => id.endsWith(".scratch.gen.ts");
const scratchIdOf = (entry) => entry.replace(/\.ts$/, ".scratch.gen.ts");
const scratchKeyOf = (entry) => `scratch\n${storage.store.label}\n${entry}`;
/** The keys of what is tried out (`"param ADDRESS"`, a drag's key), as its text has them. */
export const scratchKeys = () => [...(scratch.text ?? "").matchAll(/^ {2}("(?:[^"\\]|\\.)*"): /gm)].map((m) => JSON.parse(m[1]));
/** Whether anything is tried out. */
export const tryingOut = () => scratchKeys().length > 0;
/** Whether the model is shown as it was before what is tried out (which is then not to be added to). */
export const showingBefore = () => !scratch.on && tryingOut();
function saidScratch() {
  if (open) settings.set(scratchKeyOf(open.entry), { on: scratch.on, text: scratch.text }).catch(() => {});
  for (const f of scratch.listeners) f();
}
/** What is tried out as `text`, the change kept to undo. */
function setScratch(text, undoable = true) {
  if (text === scratch.text) return;
  if (undoable) { scratch.back.push(scratch.text); scratch.ahead = []; }
  scratch.text = text;
  saidScratch();
}
/** What is tried out, as it was kept here for the model at `entry` (none: nothing). */
async function loadScratch(entry) {
  const k = await settings.get(scratchKeyOf(entry)).catch(() => null);
  Object.assign(scratch, { on: k?.on ?? true, text: k?.text ?? null, back: [], ahead: [] });
}
const engine = (op, args) => (shownKept && !VIEW.has(op) ? real.promise.then(() => engines[front](op, args)) : engines[front](op, args));
/** Which build of the engine this is (what a model it settles is kept by). */
let stampOf = null;
const stamp = () => (stampOf ??= engines[front]("stamp"));
let buildOf = null;
/** Which build of the app this page is: `{ engine }`, its engine's stamp (what decides how a model builds and solves), and as a person can
 *  tell builds apart, as web/build.sh compiled into the engine: `commit`, `date` (the commit's, ISO), `changed` (built with changes beside
 *  it); `at`, where the page was loaded from; and `js`, the page's scripts, said the same way (`{ commit, date, changed }`, or `{}`). */
export const appBuild = () => (buildOf ??= Promise.all([stamp(), engines[front]("build").catch(() => ({})), scriptsBuild()]).then(([engine, said, js]) =>
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
const sameBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
/** A model as it was last settled here (its bytes), shown as build `version`: taken as it is by the engine the model is
 *  asked of, and by those that draw its sheets and check it, while it is built again. */
async function showKept(bytes, version, key) {
  let done;
  real = { promise: new Promise((r) => (done = r)), done: () => done() };
  shownKept = { version, key, bytes };
  // (Shown first, with nothing else at work beside it; then its sheets; then its checks, as it is built again.)
  await engines[front]("adopt", { settled: bytes, version, build: true }, "told").catch(() => {});
  await model.look().catch(() => {});
  drawer("adopt", { settled: bytes, version, build: true }, "told").catch(() => {});
  // (Its sheets asked for already, before the engine that draws them had it: asked again.)
  if (model.state?.version === version && model.state.drawn === false) await model.draw().catch(() => {});
  checker("adopt", { settled: bytes, version, build: false }, "told").catch(() => {});
  check(version);
}
/** What the files asked to be built are kept by, as settled. */
const keyOfWanted = async () => keyOf({ stamp: await stamp(), place: storage.store.label, entry: wanted.entry, files: wanted.files, scenario: wanted.scenario, names: wanted.names });

/** Changes to what is built that are not built yet, in the order made: each { op, args, wait: who waits for it }. */
const waiting = [];
/** Whether one is being built. */
let building = false;
/** How many builds there have been: which one each is (`version`), for all the engines alike. */
let builds = 0;
/** What is asked to be built, as it now is (of every change made): what an engine started again is told, whole. */
const wanted = { entry: null, files: null, scenario: null, names: null };
/** The engines that build that were started again, and have nothing: what they are told next is all of `wanted`. */
const fresh = new Set();
/**
 * A change to what is built (`open`, `setFiles`, `scenario`, `exclude`): answers, once the model is
 * built with it, with which build that is. Made while the model is being built, that build is let go of, and one is
 * made of all that is asked; of several that wait, one build is made of them all (of the files as they were said
 * twice over, the later are what is built).
 */
function change(op, args) {
  if (op === "open") Object.assign(wanted, { entry: args.entry, files: args.files, scenario: null, names: null });
  if (op === "setFiles") wanted.files = args.files;
  if (op === "scenario") wanted.scenario = args.name;
  if (op === "exclude") wanted.names = args.names;
  return new Promise((resolve, reject) => {
    const last = waiting.at(-1);
    if (last?.op === op && op !== "open") { last.args = args; last.wait.push({ resolve, reject }); }
    else waiting.push({ op, args, wait: [{ resolve, reject }] });
    if (building) { solvingSaid(); letGo(); }
    else build();
  });
}
/** What is being built is let go of: its engine started again (it is told all that is asked, next). */
function letGo() {
  const back = engines[1 - front];
  if (!back.busy()) return;
  fresh.add(back);
  back.restart();
}
/** All that is asked, as changes to an engine that has nothing. */
const whole = () => [
  { op: "open", args: { entry: wanted.entry, files: wanted.files } },
  ...(wanted.scenario != null ? [{ op: "scenario", args: { name: wanted.scenario } }] : []),
  ...(wanted.names != null ? [{ op: "exclude", args: { names: wanted.names } }] : []),
];
/** What a build waits for before it begins (the model shown as kept, first). */
let notBefore = Promise.resolve();
async function build() {
  building = true;
  await notBefore;
  while (waiting.length) {
    // (Of the model shown as it was kept: built as that build, which nothing is shown again for where it settles so.)
    const batch = waiting.splice(0), back = engines[1 - front], keepAs = batch.find((c) => c.args.keep != null)?.args.keep;
    let version = keepAs ?? ++builds;
    const told = (c) => ({ ...c.args, version, lazy: true }), key = keyOfWanted();
    // (An engine started again is told all that is asked; who waited for the changes, for that.)
    const changes = fresh.has(back) ? whole() : batch;
    fresh.delete(back);
    model.solving = { since: performance.now() };
    solvingSaid();
    try {
      // (All of them told, and built at the last.)
      for (const c of changes.slice(0, -1)) back(c.op, told(c), "told").catch(() => {});
      await back(changes.at(-1).op, { ...changes.at(-1).args, version, lazy: false });
      front = 1 - front;
      asBuilt = wanted.files ?? {};
      // (After it is built: how it was settled is kept beside it, and the other model engine builds from that, not
      // from how it was settled before.)
      const solved = await keepSolved();
      if (solved) for (const c of changes) if (c.args.files) c.args = { ...c.args, files: { ...c.args.files, [solved.id]: solved.text } };
      const other = engines[1 - front];
      for (const c of fresh.has(other) ? whole() : changes) other(c.op, told(c), "told").catch(() => {});
      fresh.delete(other);
      // The model as settled: where it was shown as kept, and settled as that, nothing more (what needs the script
      // goes on); else, if it was, a build of its own. Kept here; handed to the engines that draw its sheets and check
      // it (each let go of what it was doing of one before): they solve nothing, and nothing waits for them.
      const settled = await engines[front]("settledOut").catch(() => null), was = shownKept?.version === version ? shownKept : null;
      const same = !!was && !!settled && sameBytes(settled, was.bytes);
      if (was) { shownKept = null; real.done(); }
      if (was && !same) { version = ++builds; await engines[front]("renumber", { version }).catch(() => {}); }
      for (const c of batch) for (const w of c.wait) w.resolve(version);
      if (settled && !same) {
        key.then((k) => keepSettled(settledId(wanted.entry), k, settled)).catch(() => {});
        for (const [e, sheets] of [[drawer, true], [checker, false]]) {
          if (e.busy()) e.restart();
          e("adopt", { settled, version, build: sheets }, "told").catch(() => {});
        }
        // (Its sheets asked for already, of this build, before the engine that draws them had it: asked again.)
        if (model.state?.version === version && model.state.drawn === false) model.draw();
        // (Its checks, apart: not waited for.)
        check(version);
      }
    } catch (e) {
      // (Let go of, for a change made since: its changes are built with that, and who waited for them waits for it.)
      if (String(e?.message ?? e) === CANCELLED) { waiting.unshift(...batch); continue; }
      // (The build of the model shown as kept failed: what waits for it is let go, to be answered by the model as kept (or fail,
      // saying why), not to wait for good. And the page's next look, which waits for whatever hears of it, with it.)
      if (shownKept?.version === version) { shownKept = null; real.done(); }
      for (const c of batch) for (const w of c.wait) w.reject(e);
    }
    // (Said as soon as it is built, not when it is next looked at; after whoever waited for it has gone on.)
    setTimeout(() => model.look().catch(() => {}));
  }
  building = false;
  model.solving = null;
  solvingSaid();
}
/** Something of the build has changed (it began, ended, or another change waits for it), and whoever shows it is told. */
function solvingSaid() {
  const s = model.solving;
  if (s) model.solving = { ...s, queued: waiting.length };
  for (const f of model.solvingListeners) f(model.solving);
}
/** What is asked of the model's sheets, and so of the engine that draws them. */
const OF_SHEETS = new Set(["sheet", "exports", "export"]);
/** What something answers, or `{ error }` where it throws. */
const answered = async (f) => { try { return await f(); } catch (e) { return { error: String(e?.message ?? e) }; } };
/** The plans script beside the open model: how it is made (docs/build-plans.md). */
const plansFile = () => open?.entry.replace(/\.ts$/, ".plans.ts");

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
    // (As last asked, so the page has them at once. Asked again as the projects page is shown.)
    this.reachable = auth.signedIn() ? ((await settings.get("githubReachable").catch(() => null)) ?? []) : [];
  },
  /** The repositories the person signed in has given the App, as last asked: `{ full_name, default_branch, private }`. */
  reachable: [],
  /** Asks GitHub again: how many more there are than could be listed. Each is then a place projects are kept, unless put away. */
  async refreshReachable() {
    const r = await new GitHub({ token: auth.token, api: this.github.api ?? auth.app.api }).reachable();
    this.reachable = r.repositories;
    this.reachableAsked = true;
    await settings.set("githubReachable", r.repositories);
    return r.more;
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
  /** The page's project is in this location (which it can use: `of`). */
  use(kind) {
    this.store = this.of(kind);
    this.kind = kind;
    this.work = typeof this.store?.can === "function" ? this.store : null;
  },
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
    out.push({ kind: "host", label: this.site ? (this.site.writable ? this.site.label : `${this.site.label} (read-only: edits kept in this browser)`) : "A fettled host", store: this.of("host") });
    out.push({ kind: "browser", label: "This browser", store: this.of("browser") });
    if (FolderStore.supported()) out.push({ kind: "folder", label: this.folder ? this.folder.label : "A folder on this computer", store: this.of("folder") });
    for (const kind of this.githubKinds()) out.push({ kind, label: this.of(kind).base.label, store: this.of(kind) });
    out.push({ kind: EXAMPLES_KIND, label: "Examples", store: this.of(EXAMPLES_KIND), examples: true });
    return out;
  },
  /** The branches on GitHub listed here: of each repository the App is on, its default branch unless put away; and those
   *  opened by name, or gone to. */
  githubKinds() {
    const hidden = new Set(this.github.hidden ?? []);
    return [...new Set([...this.reachable.map((r) => `github:${r.full_name}@${r.default_branch}`).filter((k) => !hidden.has(k)), ...this.github.repos])].filter((k) => k !== EXAMPLES_KIND);
  },
  /** Those of the App's repositories put away here. */
  hiddenKinds() {
    const reach = new Set(this.reachable.map((r) => `github:${r.full_name}@${r.default_branch}`));
    return (this.github.hidden ?? []).filter((k) => reach.has(k));
  },
  /** Lists again those put away. */
  async unhideBranches() {
    this.github = { ...this.github, hidden: [] };
    await keepGithub(this.github);
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
    this.github = { ...this.github, token: token || this.github.token, repos: [...new Set([...this.github.repos, kind])], hidden: (this.github.hidden ?? []).filter((k) => k !== kind) };
    // (Made again with the token.)
    for (const k of this.github.repos) delete this.stores[k];
    await keepGithub(this.github);
    return kind;
  },
  /** One no longer listed here; a pasted token is let go of with the last. (Edits kept over it stay, for if it comes back.) */
  async unfollowBranch(kind) {
    const repos = this.github.repos.filter((k) => k !== kind);
    // (One of the App's would come back by itself: it is kept out.)
    const reach = this.reachable.some((r) => `github:${r.full_name}@${r.default_branch}` === kind);
    this.github = { ...this.github, token: repos.length ? this.github.token : null, repos, hidden: [...new Set([...(this.github.hidden ?? []), ...(reach ? [kind] : [])])] };
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

// ----- the open project -------------------------------------------------------------

let open = null; // { entry, folder, ids, beside, stamps }
/** What is being written to the store: waited for before the page is left. */
const writing = new Set();
let lastCheck = 0, lastListed = 0;
/** One look at the project's files at a time: two at once would each find the same change, and build it twice. */
let looking = Promise.resolve();

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

/** The model file and every local file it imports, and your layer over it if there is one, and what is tried out over it where it is built
 *  in (`tried`); `instead`: files (by id) as they would be, in place of those kept. */
async function gather(entry, instead = {}, tried = false) {
  const st = { read: async (id) => instead[id] ?? storage.store.read(id) };
  // (Each file is read as soon as something is known to import it: not one after another.)
  const files = {};
  // (How each was last settled, where that is kept: the engine settles from it.)
  const solvedOf = async (id) => {
    const s = solvedId(id);
    const t = await cacheOf(storage).get(s);
    if (t != null) files[s] = t;
  };
  const take = async (id) => {
    if (id in files) return;
    files[id] = null;
    const text = await st.read(id);
    if (text == null) throw new Error(`cannot read ${id}`);
    files[id] = text;
    await Promise.all([solvedOf(id), ...(await engine("imports", { source: text, id }).catch(() => [])).map(take)]);
  };
  // (Your layer over it (docs/layers.md), not imported by it, if there is one.)
  const userId = entry.replace(/\.ts$/, ".user.gen.ts");
  const [, user] = await Promise.all([take(entry), st.read(userId).catch(() => null)]);
  if (user != null) files[userId] = user;
  if (tried && scratch.on && tryingOut()) files[scratchIdOf(entry)] = scratch.text;
  return { files };
}

/** What the model is built from, whose changes are looked for at once. (Not how it was settled: that is written as it is built, and is
 *  the engine's to read, not a change of the model. The rest of the workspace is looked at less often, all together: `inWorkspace`.) */
/** What the scene made for the app to keep (a scan's confidence), kept where the app keeps such things (`cache.js`). */
async function keepScenes() {
  for (const [id, bytes] of await engine("sceneTakeKept", {}).catch(() => [])) await cacheOf(storage).set(id, bytes);
}
const watched = (o) => o.ids.filter((id) => !id.endsWith(".solved.json") && !isScratch(id));
/** What the app keeps of a part script of how it was last settled (`cache.js`): `a.ts` → `a.solved.json`. */
const solvedId = (id) => id.replace(/\.ts$/, ".solved.json");
/** What the app keeps of a part script of its sheets as last drawn: `a.ts` → `a.drawn.json`. */
const drawnId = (id) => id.replace(/\.ts$/, ".drawn.json");
/** Of a part script, built: how it was settled, kept beside it where that is new (and the store can be written);
 *  answers with what is kept (`{ id, text }`), where it is new. */
async function keepSolved() {
  const w = await engine("partSolved").catch(() => null);
  // (Not of what is tried out: what is kept is how the model itself settles, which it is shown as again when that is let go.)
  if (w && !Object.keys(asBuilt).some(isScratch)) cacheOf(storage).set(w.id, w.text);
  return w;
}

/**
 * Of a part script, built (as build `version`): checked apart, by an engine of its own (which builds it too, from
 * what was just kept of how it was settled), so that it is shown meanwhile: what a model of many parts
 * finds where its bodies meet takes seconds. What that finds is said with it, and kept with its settle beside it:
 * the next build of the same settle says it at once (and then nothing is checked here).
 */
async function check(version) {
  const c = await answered(() => checker("partChecks"));
  if (!c || c.error || c.said == null || c.version !== version) return;
  model.checks = { version, said: c.said };
  for (const f of model.checkedListeners) f(model.checks);
  if (version !== builds) return;
  await engine("partChecked", { key: c.key, said: c.said }).catch(() => {});
  await keepSolved();
}

/** The project the page is of, from when it is asked to be opened: one, once (`project.open`). */
let opened = null;

/**
 * Hands the engine the project's files again if any changed in storage (looked at, at most, once a second; `now`:
 * at once, as by whoever has just changed one). `force`: whether they changed or not. Where the model is built
 * again for it, `{ built }`: answered when it is (which is not waited for here: the files are looked at again
 * meanwhile, and what else has changed is built next).
 */
const refresh = (force = false, now = force) => (looking = looking.catch(() => {}).then(() => refreshNow(force, now)));
async function refreshNow(force, soon) {
  if (!open?.stamps) return;
  const now = Date.now();
  if (!soon && now - lastCheck < 900) return;
  lastCheck = now;
  const o = open;
  // (What the workspace has is looked at less often than whether what the model is built from has changed.)
  let other = false;
  if (force || now - lastListed > 4000) {
    lastListed = now;
    const all = await inWorkspace(o.home), sign = signOf(all);
    other = sign !== o.sign;
    Object.assign(o, { beside: all.map((f) => f.id), sizes: new Map(all.map((f) => [f.id, f.size])), sign });
  }
  const stamps = await storage.store.stat(watched(o));
  const differs = (id) => stamps[id] !== o.stamps[id];
  // The model is built again where what it is built from changed; a file it is not built from is read again by whoever has it open.
  const built = force || watched(o).some(differs);
  if (!built && !other) return;
  let made;
  if (built) {
    const { files } = await gather(o.entry, {}, true);
    o.ids = Object.keys(files);
    made = change("setFiles", { files });
  }
  // (As they were before they were read: one changed while it was read is found changed again. What the model
  // has only now come to be built from, as it is now.)
  o.stamps = { ...(await storage.store.stat(watched(o))), ...stamps };
  if (other && !built && open === o) for (const f of project.fileListeners) f();
  return made && { built: made };
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

export const project = {
  /**
   * Opens the root part the page is of (by its file's id among the files): once, as the page is loaded (another is
   * gone to by loading the page again with it: `go`, or a tab of its own: each has its own engine, and the same workspace). `{ remember: false }`:
   * one looked at as it was at a commit, which is not among those opened last. `{}`, or `{ error }` (nothing is then
   * open, and nothing else is opened in its place).
   */
  open: (entry, { remember = true } = {}) => answered(async () => {
    if (opened) throw new Error(`${opened} is open here: go to another (project.go)`);
    opened = entry;
    began(entry);
    try {
      // Its files, as they are listed where it is kept, said at once: they can be looked at while it is built (which
      // files it is built from is known once they are read, and the engine has said what each imports).
      step("page", "listing its files");
      const home = homeOf(entry), all = await inWorkspace(home), listed = all.map((f) => f.id);
      const ids = [entry, ...listed.filter((id) => id !== entry)];
      for (const f of project.listedListeners) f({ entry, home, ids });
      step("page", "reading the files it is built from");
      await loadScratch(entry);
      const { files } = await gather(entry, {}, true);
      // (Among those opened last as soon as it is had: its model may take a while to build.)
      if (remember) {
        const at = { in: storage.kind, path: entry }, was = (await settings.get(RECENT_KEY).catch(() => null)) ?? [];
        // (Not a session shared over the internet: it is at a link, and nowhere else.)
        if (storage.kind !== RELAYED) settings.set(RECENT_KEY, [at, ...was.filter((r) => r.in !== at.in || r.path !== at.path)].slice(0, RECENT)).catch(() => {});
        if (project.inAddress(location.href).entry !== entry || (new URL(location.href).searchParams.get("in") ?? "host") !== storage.kind) history.replaceState(history.state, "", project.href(entry, storage.kind) + location.hash);
      }
      // Which project is open is said now: its files are watched from here (one changed while it is first built is
      // built in place of what it was), and read, saved and looked at.
      const now = (open = { entry, home, ids: Object.keys(files), beside: listed, sizes: new Map(all.map((f) => [f.id, f.size])), sign: signOf(all), stamps: null });
      now.stamps = await storage.store.stat(watched(now));
      lastListed = Date.now();
      // As it was last settled here, where that was of just these files: shown at once (the engines that show it,
      // draw its sheets and check it take it as it is: nothing run, nothing solved), and built again behind it.
      step("page", "looking for it as last settled here");
      Object.assign(wanted, { entry, files, scenario: null, names: null });
      asBuilt = files;
      const key = await keyOfWanted(), was = await keptSettled(settledId(entry), key);
      const keep = was ? ++builds : undefined;
      if (was) notBefore = showKept(was, keep, key).catch(() => {});
      step("page", "waiting for the engine to build it");
      change("open", { entry, files, keep }).then(() => idle("page"), (e) => { idle("page"); model.failed(entry, e); });
      return {};
    } catch (e) { opened = null; open = null; step("page", `could not open it: ${e?.message ?? e}`); idle("page"); throw e; }
  }),
  listedListeners: [],
  /** `f({ entry, home, ids })` as soon as the files of the workspace of the part being opened are listed (before anything is read,
   *  and before its model is built): those files, the part's first; `home`: the folder they are all in. */
  onListed(f) {
    this.listedListeners.push(f);
  },
  /** The project that is open (its model's id among the files), or none. */
  current: () => open?.entry ?? null,
  /** The project the page is of: open, or being opened (its model may take a while to build); or none. */
  ofPage: () => opened,
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
  tooBig: (id) => (open?.sizes.get(id) ?? 0) > TOO_BIG,
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
    await looking.catch(() => {});
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
    const { slug, text } = await engine("newWorkspace", { name: name.trim() });
    if (!slug) throw new Error("a workspace's name needs a letter or a digit in it");
    if ((await store.list()).some((f) => workspaceOf(f.id) === slug)) throw new Error(`there is already a workspace ${slug} there`);
    const id = idOf(slug, MODEL);
    await store.write(id, text);
    return { file: id };
  }),
  /** Makes a model of this name in a workspace (a folder of it, with its model in it): `{ file }`, to go to. */
  createModel: (name, workspace, kind) => answered(async () => {
    if (!name.trim()) throw new Error("give the model a name");
    const store = storage.of(kind);
    if (!store?.writable) throw new Error("it cannot be made there now");
    const { slug, text } = await engine("newWorkspace", { name: name.trim() });
    const id = idOf(workspace, `${slug}/${MODEL}`);
    if ((await store.read(id)) != null || (await store.read(idOf(workspace, `${slug}.ts`))) != null) throw new Error(`${slug} already exists in ${workspace}`);
    await store.write(id, text);
    return { file: id };
  }),
  /**
   * The workspace's files: `{ files: [{ path, name, text, built }] }`, the root part first (`name`: from the workspace's folder; `built`: the
   * model is built from it). Only what it is built from has its text: there may be any number of the rest, each read when it is opened.
   */
  sources: () => answered(async () => {
    if (!open) throw new Error("no model open");
    const o = open, files = [], prefix = o.home, built = o.ids.filter((id) => !/\.solved\.json$/.test(id));
    const ids = [...new Set([...built, ...o.beside])].sort((a, b) => (b === o.entry) - (a === o.entry) || a.localeCompare(b));
    const texts = await Promise.all(ids.map((id) => (built.includes(id) ? storage.store.read(id) : null)));
    ids.forEach((id, k) => files.push({ path: id, name: id.startsWith(prefix) ? id.slice(prefix.length) : id, text: texts[k] ?? "", built: built.includes(id) }));
    return { files };
  }),
  fileListeners: [],
  /** `f()` when the workspace's files have changed (one more, one fewer, one edited elsewhere). */
  onFiles(f) {
    this.fileListeners.push(f);
  },
  /** Saves one of its files; the model is built again: `{ model_error }` (why it does not build, if it does not). */
  save: (path, text) => answered(async () => {
    if (!open?.ids.includes(path) && !open?.beside.includes(path)) throw new Error(`${path} is not one of this project's files`);
    await storage.store.write(path, text);
    await (await refresh(true))?.built;
    return { model_error: (await engine("state")).error ?? null };
  }),
  /** One of its files has just been written here: it is looked at now, not when the files are next looked at, and the model built again with it (which is not waited for). */
  touched: () => answered(async () => { await refresh(false, true); return {}; }),
};

// ----- the model: the open project, as the engine has built it -----------------------------------

/** The open project's model. Whoever shows something of it listens for its changes. */
export const model = {
  /** The engine's state of it, as last asked (`version`: another on every build; `file`: the project). */
  state: null,
  listeners: [],
  /** `f(state, was)` whenever another project is open, or this one has been built again. */
  onChange(f) {
    this.listeners.push(f);
  },
  drawnListeners: [],
  brokenListeners: [],
  /** `f(error)` when one of its engines could not be started (its scripts not loaded, tried again and again): what is asked of
   *  that one fails from then, saying so. */
  onBroken(f) {
    this.brokenListeners.push(f);
  },
  /** What checking it found apart (`{ version, said }`), after it was shown (`check`): of which build. */
  checks: null,
  /** That, of the build its state is of; none, where its checks are said with it (or are not found yet). */
  get checksSaid() {
    return this.checks && this.checks.version === this.state?.version ? this.checks.said : null;
  },
  checkedListeners: [],
  /** `f(checks)` when checking a build of it apart has found what is wrong with it. */
  onChecked(f) {
    this.checkedListeners.push(f);
  },
  /** `f(state)` when the sheets of the model as built have been drawn: they are in its state from then (`sheets`), not before. */
  onDrawn(f) {
    this.drawnListeners.push(f);
  },
  /**
   * Has its sheets drawn (by the engine that draws them), and says so when they are: of the build its state is
   * of, and no other. One drawing at a time: built again meanwhile, however often, it is drawn once more when
   * this is done, as it then is (the builds between are not drawn at all).
   */
  async draw() {
    if (this.drawing) return void (this.drawAgain = true);
    this.drawing = true;
    try {
      do {
        this.drawAgain = false;
        // (From its sheets as last drawn, where they are of this build; else drawn, and kept.)
        const kept = open ? await cacheOf(storage).get(drawnId(open.entry)) : null;
        const d = await answered(() => drawer("drawn", { kept }));
        if (d.keep) cacheOf(storage).set(d.keep.id, d.keep.text);
        if (d.error || d.version !== this.state?.version || this.state.drawn) continue;
        this.state = { ...this.state, sheets: d.sheets, sheet_errors: d.sheet_errors, drawn: true };
        for (const f of this.drawnListeners) await f(this.state);
        reached("sheets");
      } while (this.drawAgain);
    } finally {
      this.drawing = false;
    }
  },
  /**
   * While it is being built again, how far that has come: `{ since, queued (changes made since, that wait to be
   * built), stage ("fit", "report", "checks"; none yet: it has only begun), part (the model used as a part that is
   * being fitted, if one is), round, column, columns, step, share (of the whole, 0 to 1; null: not known) }`.
   * Null: it is not. The model as it was is asked meanwhile, and answers.
   */
  solving: null,
  solvingListeners: [],
  /** `f(solving)` whenever that changes. */
  onSolving(f) {
    this.solvingListeners.push(f);
  },
  /** Whether a change to it is being built, or waits to be. */
  get busy() {
    return building || waiting.length > 0;
  },
  /** Whether it is built (a project is open, and its script ran). */
  get built() {
    return !!this.state && !this.state.error;
  },
  /** Asks the engine for its state, and says what changed: one asking at a time. */
  look() {
    return (this.looked = (this.looked ?? Promise.resolve()).catch(() => {}).then(async () => {
      // (Its state, asked of the engine only where it is of another build than the one had: saying it is not nothing.)
      if (open && this.state?.file && (await engine("version")) === this.state.version) return;
      if (open && !this.state?.file) step("page", "asking for the model's state");
      let s = open ? await engine("state") : { version: -1, file: "", error: "No project is open: choose one, or make one, on the projects page." };
      // (Nothing built yet, nor shown as kept: nothing to say.)
      if (!s) return;
      if (open && s.file && !this.state?.file) step("page", "showing the model");
      if (!this.state || s.version !== this.state.version) {
        const was = this.state;
        // (Its sheets, drawn again after it is built again: those of before are listed meanwhile, so that what is
        // listed under them does not jump up and back under the pointer.)
        if (was && s.file === was.file && s.drawn === false && !s.sheets?.length && was.sheets?.length) s = { ...s, sheets: was.sheets };
        this.state = s;
        if (s.file) reached("state");
        // Its sheets are drawn by an engine of their own, from now: then listed.
        if (s.drawn === false) this.draw();
        // (Each is told at once, and none waits for another to be done with it: the 3D view asks for its parts
        // while the files are read. The next look at the engine waits for them all.)
        await Promise.all(this.listeners.map(async (f) => f(s, was)));
      }
    }));
  },
  /** Its build failed (not the script: the engine, as it was asked): said as its state, of the project being opened. */
  failed(entry, e) {
    const was = this.state, s = { version: -1, file: entry, error: `it could not be built: ${e?.message ?? e}` };
    this.state = s;
    for (const f of this.listeners) f(s, was);
  },
  /** Looks once a second for what changed (its files, and so it), and says so; `failed(e)` when looking does. */
  async watch(failed) {
    try {
        await refresh();
      await this.look();
    } catch (e) {
      failed?.(e);
    }
    setTimeout(() => this.watch(failed), 1000);
  },
  /**
   * Asks something of the model as built: "sheet" (a drawing, as SVG), "member", "ratios", "deflected" (fettled-app's
   * requests, with their arguments).
   */
  ask: (what, args) => answered(() => (OF_SHEETS.has(what) ? drawer : engine)("request", { op: what, args })),
  /**
   * How it is made (docs/build-plans.md): the plans script beside it (`<model>.plans.ts`), evaluated beside it:
   * `{ file, tree }` (the tree as written, each leaf with the parts it makes, and every part); `{ file, none: true }`
   * where there is none; `{ file, error }` where it does not evaluate.
   */
  plans: () => answered(async () => {
    if (!open) throw new Error("no model open");
    const file = plansFile();
    const text = await storage.store.read(file).catch(() => null);
    if (text == null) return { file, none: true };
    try { return { file, tree: await engine("plans", { file, text }) }; } catch (e) { return { file, error: String(e?.message ?? e) }; }
  }),
  /** Its parts as solids (`{ members, stats, structure }`), made once for each build; with its fastenings among them,
   *  where they are shown (`filters.js`). */
  parts() {
    const version = this.state?.version, fixings = showsFixings();
    if (!this.mesh || this.mesh.version !== version || this.mesh.fixings !== fixings) {
      const made = this.built ? this.ask("mesh") : Promise.resolve({ error: this.state?.error ?? "no project is open" });
      this.mesh = { version, fixings, made: fixings && this.built ? Promise.all([made, this.fastenings()]).then(([m, f]) => (m.error || !f.parts.length ? m : { ...m, members: [...m.members, ...f.parts] })) : made };
    }
    return this.mesh.made;
  },
  /** Its parts' exact bodies, as `bodies` has them; with its fastenings', where they are shown. */
  async bodies() {
    const [bodies, f] = await Promise.all([this.ask("bodies"), showsFixings() ? this.fastenings() : null]);
    return f?.bodies.length && Array.isArray(bodies) ? [...bodies, ...f.bodies] : bodies;
  },
  /** Its fastenings drawn (`{ parts, bodies }`: each nail its nailings lay out), made once for each build; none where
   *  the engine cannot say them. */
  fastenings() {
    const version = this.state?.version;
    if (!this.fixed || this.fixed.version !== version) this.fixed = { version, made: this.ask("fastenings").catch((e) => (console.warn("fastenings:", e), { parts: [], bodies: [] })) };
    return this.fixed.made;
  },
  /**
   * Its parts as they would be with these files (by id, each its text) in place of the project's own: built
   * aside, the model that is open left as it is. A proposal's side, which is every part of it and not its members alone.
   */
  partsWith: (files) => answered(async () => {
    if (!open) throw new Error("no model open");
    return engine("meshOf", { entry: open.entry, files: (await gather(open.entry, files)).files });
  }),
  /** Builds it for a scenario of its script's (by name). */
  scenario: (name) => answered(() => change("scenario", { name })),
  /** Builds it without these load cases (by name). */
  exclude: (names) => answered(() => change("exclude", { names })),
  /** Of a part script: keeps params beside it (`{ address: { value, tier } }`, from its root: a tier as the engine has
   *  it, `"must"`, `{ at: { level, within } }` or `"start"` (free), held where none is said; null lets one go); it is
   *  built again. `{ file }`. */
  params: (params, { scratch: tried = false } = {}) => answered(async () => {
    const w = await engine("partParams", { params, scratch: tried });
    await keepOf(w);
    await (await refresh(true))?.built;
    return { file: w.id };
  }),
  /** Of a part script: entries let go of (by their keys: `param ADDRESS`, a drag's key), wherever a person has them: in their
   *  layer, or tried out. It is built again. `{ files }`. */
  letGo: (keys) => answered(async () => {
    const ws = await engine("partLetGo", { keys });
    for (const w of ws) await keepOf(w);
    if (ws.length) await (await refresh(true))?.built;
    return { files: ws.map((w) => w.id) };
  }),
  /** Of a part script: what is tried out (by keys; none: all of it) kept in your layer (in a session, everyone's), as firmly
   *  as `tier` says (as the engine has it; none: as it was tried); let go of from what is tried out. It is built again. */
  keepScratch: (keys = null, tier = null) => answered(async () => {
    if (!scratch.on) throw new Error("what is tried out is turned off: turn it on to keep it");
    const ws = await engine("partKeepScratch", { keys, tier });
    for (const w of ws) await keepOf(w);
    await (await refresh(true))?.built;
    return { files: ws.map((w) => w.id) };
  }),
  /** What is tried out let go of, all of it (undoable); built again as the model is. */
  clearScratch: () => answered(async () => {
    setScratch(null);
    await (await refresh(true))?.built;
    return {};
  }),
  /** What is tried out built in, or not (`on`), to compare: built again. */
  scratchOn: (on) => answered(async () => {
    scratch.on = !!on;
    saidScratch();
    await (await refresh(true))?.built;
    return {};
  }),
  /** The last change to what is tried out undone (`redo`: the last undone, made again); built again. */
  scratchStep: (redo = false) => answered(async () => {
    const [from, to] = redo ? [scratch.ahead, scratch.back] : [scratch.back, scratch.ahead];
    if (!from.length) return {};
    to.push(scratch.text);
    setScratch(from.pop(), false);
    scratch.on = true;
    saidScratch();
    await (await refresh(true))?.built;
    return {};
  }),
  /** Of a part script: entries of your layer (docs/layers.md; by their keys: `param ADDRESS`, a drag's key; none:
   *  all of yours) kept for everyone, moved into the model's own generated file; it is built again. `{ files }`. */
  share: (keys) => answered(async () => {
    const ws = await engine("partShare", { keys });
    for (const w of ws) await keepOf(w);
    await (await refresh(true))?.built;
    return { files: ws.map((w) => w.id) };
  }),
  /** Of a part script: one of its scene's tools (fettled-scan's, as a host has them: slabs, polylines, planes, selections, views, what
   *  is scratch, and a scan's, where it has one and it is read), by `who`. What it writes is kept, and the model built again with it.
   *  `{ content, isError, written }`. `page`: `{ names, shared }`, who people are called and whether others make things here at once. */
  sceneCall: (who, tool, args, page, land = true) => answered(async () => {
    const r = await engine("sceneCall", { who, tool, args, page, land });
    await keepScenes();
    for (const w of r.written ?? []) if (w.text != null) await keepOf(w);
    if (r.written?.length) await (await refresh(true))?.built;
    return r;
  }),
  /** What its scene says of itself (fettled-scan's `Scene::state_json`); null where it is not a part script. */
  /** Its scene's scans read on, a slice at a time (`fettled_scan::reading`): how far the read has come; null where there is none to
   *  read, or it will not be. */
  sceneRead: async (page) => { const p = await engine("sceneRead", { page }).catch(() => null); await keepScenes(); return p; },
  sceneState: async (page) => { const s = await engine("sceneState", { page }).catch(() => null); await keepScenes(); return s; },
  /** What a viewer asks of its scene as it draws (`fettled_scan::drawn`): an `ArrayBuffer`, or of `rays`, `pick` and
   *  `evidence`, what it says; null where it cannot be (said in the console). */
  sceneDraw: async (what, args, page) => {
    try {
      const b = await engine("sceneDraw", { what, args, page });
      await keepScenes();
      return ["rays", "pick", "evidence"].includes(what) ? JSON.parse(new TextDecoder().decode(b)) : b.buffer;
    } catch (e) {
      console.warn(`the scene's ${what}: ${e?.message ?? e}`);
      return null;
    }
  },
  /** The tools its scene has, as MCP lists them: `[{ name, description, inputSchema }]`. */
  sceneTools: () => engine("sceneTools", {}),
  /** Its scene's scans, each given to the engine to read by its ranges from where it is kept: whether every one is there. */
  sceneScans: async (page) => {
    const ids = await engine("sceneScans", { page }).catch(() => []);
    let all = true;
    for (const id of ids) {
      const source = await storage.store.bytes?.(id).catch(() => null);
      all = all && !!source && (await engine("sceneReader", { id, source }));
    }
    // (And what the app keeps of them, where it has: a scan's layout, read in part where the scan is too big to read whole.)
    for (const id of await engine("sceneKept", { page }).catch(() => [])) {
      const source = await cacheOf(storage).bytes(id);
      if (source) await engine("sceneReader", { id, source });
    }
    return all;
  },
  /** Of a part script: keeps these drags beside it (all of them, as `params` answers them: `{ what, from, to, tier }`),
   *  in place of those kept; it is built again. `{ file }`. */
  drags: (drags, { scratch: tried = false } = {}) => answered(async () => {
    const w = await engine("partDrags", { drags, scratch: tried });
    await keepOf(w);
    await (await refresh(true))?.built;
    return { file: w.id };
  }),
  /** Of a part script: keeps a reading beside it by `name` (`{what, within}`: what was read, by addresses from its
   *  root, and to within how much), or lets the one of that name go (`reading` none); it is built again. `{ file }`. */
  read: (name, reading) => answered(async () => {
    const w = await engine("partReading", { name, reading });
    await keepOf(w);
    await (await refresh(true))?.built;
    return { file: w.id };
  }),
  /** Of a part script, as a person drags: what is grabbed (`{ node }`, by address from its root; `{ point: { part,
   *  at } }`, a part by a point of it; `{ face: { part, at, normal } }`, a face pushed and pulled; each where it was
   *  grabbed, in the root's frame) on the cursor's ray, from `from` toward `to` (millimetres, the root's frame), at the
   *  level dragged, with what is kept (in place of a drag kept of the same thing, or `beside` it): `{ bodies, params }`
   *  as they then are, or `{ error }`. Nothing is kept or built again. */
  grab: (what, from, to, beside = false) => engine("partGrab", { what, from, to, beside }).catch((e) => ({ error: e.message ?? String(e) })),
  /** Of a part script, as a param's value is dragged across in the Params panel: the param at `address` (from its
   *  root) at `value`, as firmly as `tier` says (as the engine has it; held where none is), in place of what is kept
   *  of it: `{ bodies, params }` as they then are, or `{ error }`. Nothing is kept or built again; let go of as a drag
   *  is (`grabEnd(false)`), and kept by `params`. */
  paramDrag: (address, value, tier) => engine("partParamDrag", { address, value, tier }).catch((e) => ({ error: e.message ?? String(e) })),
  /** Of a part script as built: what must hold that the param at `address` is of (a list, each by what says it): what
   *  decides it, where what must hold does; or `{ error }`. */
  mustsOf: (address) => engine("partMustsOf", { address }).catch((e) => ({ error: e.message ?? String(e) })),
  /** Of a part script as built: how the node at `address` can move with all that must hold held: `{ rank, dirs,
   *  params }`, or `{ error }`. */
  ways: (address) => engine("partWays", { address }).catch((e) => ({ error: e.message ?? String(e) })),
  /** Of a part script: a drag let go of; the next begins from the part as built. Kept (`keep`): the drag as it last was
   *  is kept beside it, and it is built again: `{ file, drags }` (the drags kept before it, to undo it), or `{}` where
   *  nothing was dragged. */
  grabEnd: (keep, { scratch: tried = false } = {}) => answered(async () => {
    const w = await engine("partGrabEnd", { keep, scratch: tried });
    if (!w) return {};
    await keepOf(w);
    await (await refresh(true))?.built;
    return { file: w.id, drags: w.drags };
  }),
};
