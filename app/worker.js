// The engine, off the UI thread: the fettled wasm module (settling part scripts, analysis, drawings, 3D) plus the
// browser's own JavaScript engine running the part scripts. Messages: {id, op, args} → {id, ok, value | error, ms}.
//
// Each is one of three engines (docs/engines.md; project.js says which): a root part's model engine, which takes the
// settled model (`adopt`) and answers what is asked of it, making each product of it when first asked for; a root
// part's solver, which runs its script and settles it (`open`, `setFiles`, `scenario`), hands out what it settled
// (`settledOut`) and answers what needs the script (a drag); and the page's background engine, which keeps a few
// settled models by their keys and makes what takes seconds of them (sheets drawn, where bodies meet).
import init, * as wasm from "../pkg/fettled_wasm.js";
import { read, sizeOf } from "./ranges.js";

// Each step of its work said to the page as it begins (its build log), timed from when the epoch began (the page's
// clock and a worker's start apart): one the engine says (`__fettled_step`, of what it is doing within something asked of
// it), each thing asked of it, and its stopping.
const now = () => performance.timeOrigin + performance.now();
const say = (step) => self.postMessage({ step, t: now() });
say("starting the engine");
globalThis.__fettled_step = (what) => say(what);
/** The engine's module, loaded: tried again where loading it fails (the server not answering for a moment, say), a few
 *  times and then on whatever is asked next, never left failed from one try for good. */
let loading = null;
const TRIES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = () => (loading ??= (async () => {
  for (let k = 1; ; k++) {
    try {
      await init({ module_or_path: new URL("../pkg/fettled_wasm_bg.wasm", import.meta.url) });
      break;
    } catch (e) {
      if (k >= TRIES) throw new Error(`the engine's module could not be loaded: ${e?.message ?? e}`);
      say(`could not load the engine's module (${e?.message ?? e}): trying again`);
      await sleep(250 * 2 ** k);
    }
  }
  // A native helper scripts call: a data table by its name.
  globalThis.__fettled_data = (name) => wasm.table_json(name);
  // What a part script's scope reads, while the engine runs it (see fettled).
  globalThis.__fettled_value = (expr) => wasm.fettled_value(expr);
  globalThis.__fettled_geometry = (json) => wasm.fettled_geometry(json);
  globalThis.__fettled_said = (address) => wasm.fettled_said(address);
})().catch((e) => { loading = null; throw e; }));
// (Started, with nothing asked of it yet: it stops, rather than being said to be starting for good.)
ready().then(() => { if (!asking) say(null); }, (e) => { if (!asking) say(`could not start: ${e?.message ?? e}`); });

/** The model this engine built (a solver's): its script run and settled. */
let app = null;
/** Which build of it that is (`version`, as the page numbers them). */
let generation = 0;
/** The settled models it was handed (a model engine's, the background engine's), by key: each `{ app, version }`, the
 *  last handed the one asked of where no key is said; at most `keep` of them, the oldest let go of. */
const models = new Map();
let latest = null;
/** The model something is asked of: the settled model of `key`, where one is said; else the last handed; else the one built. */
const modelOf = (key) => {
  const m = key != null ? models.get(key) : latest != null ? models.get(latest) : null;
  if (key != null && !m) throw new Error(`no settled model ${key} here`);
  return m ?? (app ? { app, version: generation } : null);
};
const current = (key) => {
  const m = modelOf(key);
  if (!m) throw new Error("no model open");
  return m.app;
};
/** The version of the model asked of. */
const versionOf = (key) => modelOf(key)?.version ?? null;

const ops = {
  /** A root part's script, run (a solver's), as build `version`: what is kept of settles that its settle may begin from, by their
   *  keys (`{ wanted }`: each found by `settles/KEY.json`, `cache.js`), for its settle to be handed them (`settle`); `wanted` null,
   *  where it does not run (said in its state). `points`: the key of the points a host serving the page has read of its point
   *  clouds, where it has (a settle it kept of them is taken as it is). */
  open({ entry, files, version, points }) {
    app?.free();
    app = new wasm.App(entry, JSON.stringify(files));
    const wanted = app.open_part_with(points ?? undefined);
    generation = version;
    return { wanted: wanted ? JSON.parse(wanted) : null };
  },
  /** The script run (`open`) settled, from what is kept of settles that it is handed (`found`: `[[key, text]]`), and built:
   *  `{ wantsPoints }`: whether it wanted its point clouds' points, and so is not built (it is taken from a host that settles it
   *  with them). */
  settle({ found, points }) {
    app.settle_part(JSON.stringify(found ?? []), points ?? undefined);
    return { wantsPoints: app.wants_points() };
  },
  /** What its sheets as drawn are kept by (an id, `settles/KEY.drawn.json`), of the settled model of `key`; null where it is not known. */
  drawnFile({ key } = {}) {
    return current(key).drawn_file() ?? null;
  },
  /** Which build of the engine this is (what a model it settled is kept by). */
  stamp() {
    return wasm.engine_stamp();
  },
  /** Which build of the engine this is, as a person can tell (`{ commit, date, changed }`, as web/build.sh said it). */
  build() {
    return JSON.parse(wasm.engine_build());
  },
  /** The model it built, as data (a solver's): what a model engine and the background engine take (`adopt`). */
  settledOut() {
    if (!app) throw new Error("no model built");
    return app.settled_out();
  },
  /** A settled model (`settledOut`'s), taken as it is, by its key, as build `version`: nothing is run, solved or made of it
   *  till it is asked for. The one asked of from now; with at most `keep` kept (the oldest let go of). */
  adopt({ key, settled, version, keep = 1 }) {
    // (A model engine's, of one root part: taken in place of the one it had, whose scene, and the point clouds it has read, stay.)
    const was = keep === 1 && latest != null ? models.get(latest) : null;
    if (was) { was.app.take(settled); models.delete(latest); models.set(key, { app: was.app, version }); latest = key; return version; }
    models.get(key)?.app.free();
    models.delete(key);
    models.set(key, { app: wasm.App.adopt(settled), version });
    latest = key;
    for (const k of models.keys()) {
      if (models.size <= keep) break;
      models.get(k).app.free();
      models.delete(k);
    }
    return version;
  },
  /** The settled model of `key` let go of (its root part closed). */
  drop({ key }) {
    models.get(key)?.app.free();
    models.delete(key);
    if (latest === key) latest = null;
  },
  /** Whether it has the settled model of `key`. */
  has({ key }) {
    return models.has(key);
  },
  /** Its files, and its scenario, as a solver's: then built again, as build `version`. */
  setFiles({ files, version }) {
    app.set_files(JSON.stringify(files));
    app.rebuild();
    return (generation = version);
  },
  scenario({ name, version }) {
    app.set_scenario(name || "");
    app.rebuild();
    return (generation = version);
  },
  /** The files a model engine's scene reads and writes (the root part's, as they now are): nothing is built. */
  files({ files }) {
    current().set_files(JSON.stringify(files));
  },
  /** The load cases its checks leave out: its checks (and sheets) made again when next asked for; nothing is built. */
  exclude({ names, key }) {
    current(key).set_excluded(JSON.stringify(names));
  },
  state({ key } = {}) {
    const m = modelOf(key);
    return m ? { ...JSON.parse(m.app.state()), version: m.version } : null;
  },
  /** Which build its state would be of (none, where nothing is open): to look at its state only where that is new. */
  version({ key } = {}) {
    return versionOf(key);
  },
  request({ op, args, key }) {
    const out = current(key).request(op, JSON.stringify(args ?? {}));
    return op === "sheet" ? out : JSON.parse(out);
  },
  /** A plans script beside the model (`file`, its `text`), evaluated beside it: its tree, each leaf with the parts it makes. */
  plans({ file, text }) {
    return JSON.parse(current().plans(file, text));
  },
  /** Its sheets, drawn (the list of them, and what is amiss with them), and which build they are of: from what was kept
   *  of them as drawn (`kept`: the text kept by `drawnFile`) where that is of this build; else drawn, and what to keep
   *  of them (`keep`: `{id, text}`, to write). */
  drawn({ kept, key } = {}) {
    const m = current(key);
    if (kept != null) m.keep_drawing(kept);
    const drawn = JSON.parse(m.request("draw", "{}")), keep = m.part_drawn();
    return { ...drawn, version: versionOf(key), keep: keep ? JSON.parse(keep) : null };
  },
  /** The parts of another model, built for this and let go of: the open project's with other files (a proposal's side);
   *  with its bodies. */
  meshOf({ entry, files }) {
    const other = new wasm.App(entry, JSON.stringify(files));
    try {
      other.rebuild();
      const error = JSON.parse(other.state()).error;
      if (error) throw new Error(error);
      return { ...JSON.parse(other.request("mesh", "{}")), bodies: JSON.parse(other.request("bodies", "{}")) };
    } finally {
      other.free();
    }
  },
  /** Of a part script: params kept beside it (`{address: {value, tier}}`; null lets one go): `{id, text}`, to write. */
  partParams({ params, scratch }) {
    return JSON.parse(current().part_params(JSON.stringify(params), !!scratch));
  },
  /** Of a part script: what is tried out (by keys; none: all) kept in your layer, as firmly as `tier` says (none: as it
   *  was tried): `[{id, text}]`, yours to write and the scratch layer's for the page to keep. */
  partKeepScratch({ keys, tier }) {
    return JSON.parse(current().part_keep_scratch(JSON.stringify(keys ?? null), tier == null ? undefined : JSON.stringify(tier)));
  },
  /** Of a part script: entries of your layer (by their keys; none: all) kept for everyone, moved into the model's own
   *  generated file: `[{id, text}]`, to write. */
  partShare({ keys }) {
    return JSON.parse(current().part_share(JSON.stringify(keys ?? null)));
  },
  /** One of the model's scene's tools (fettled-scene's, as a host has them), by `who`: `{ content, written, isError? }`, the files it
   *  wrote, to keep. `page`: `{ names, shared }`. */
  sceneCall({ who, tool, args, page, land = true }) {
    return JSON.parse(current().scene_call(who, tool, JSON.stringify(args ?? {}), JSON.stringify(page ?? {}), land));
  },
  /** Its point clouds read on for a slice: how far the read has come (`fettled_scene::reading::Progress`). */
  sceneRead({ page }) {
    return JSON.parse(current().scene_read(JSON.stringify(page ?? {})));
  },
  /** What the scene says of itself. */
  sceneState({ page }) {
    return JSON.parse(current().scene_state(JSON.stringify(page ?? {})));
  },
  /** What a viewer asks of it as it draws (`fettled_scene::drawn`): bytes (JSON, of `rays`, `pick` and `evidence`). */
  sceneDraw({ what, args, page }) {
    return current().scene_draw(what, JSON.stringify(args ?? {}), JSON.stringify(page ?? {}));
  },
  /** The tools a scene has, as MCP lists them (`fettled_scene::listed`). */
  sceneTools() {
    return JSON.parse(wasm.scene_tools());
  },
  /** What the app keeps of its point clouds that it would read (their layouts, their confidence): the ids, to give readers of where kept. */
  sceneKept({ page }) {
    return JSON.parse(current().scene_kept(JSON.stringify(page ?? {})));
  },
  /** What it has made for the app to keep since last asked: `[[id, bytes], …]`. */
  sceneTakeKept() {
    return current().scene_take_kept();
  },
  /** The ids of the files its point clouds are, to give readers of. */
  scenePoints({ page }) {
    return JSON.parse(current().scene_points(JSON.stringify(page ?? {})));
  },
  /** A point cloud's file, as the store gives it (`{ url }` or `{ file }`), read by its ranges here. Whether it is there. */
  sceneReader({ id, source }) {
    const size = sizeOf(source);
    if (size == null) return false;
    current().scene_reader(id, size, (offset, length) => read(source, offset, length));
    return true;
  },
  /** Of a part script: the drags kept beside it, all of them: `{id, text}`, to write. */
  /** Of a part script: entries let go of (by key), from your layer and what is tried out: `[{id, text}]`, each changed. */
  partLetGo({ keys }) {
    return JSON.parse(current().part_let_go(JSON.stringify(keys)));
  },
  partDrags({ drags, scratch }) {
    return JSON.parse(current().part_drags(JSON.stringify(drags), !!scratch));
  },
  /** Of a part script, as a person drags: what is grabbed (a node, a point of a part, a face) on the cursor's ray,
   *  `from` toward `to` (mm, in the root's frame), at the level dragged, with what is kept (in place of a drag kept of
   *  the same thing, or `beside` it): `{bodies, params}` as they then are. Nothing is written. */
  partGrab({ what, from, to, beside }) {
    return JSON.parse(current().part_grab(JSON.stringify(what), new Float64Array(from), new Float64Array(to), !!beside));
  },
  /** Of a part script, as a param's value is dragged across: the param at `address` at `value`, as firmly as `tier`
   *  says (held where none is): `{bodies, params}` as they then are. Nothing is written. */
  partParamDrag({ address, value, tier }) {
    return JSON.parse(current().part_param_drag(address, value, tier == null ? undefined : JSON.stringify(tier)));
  },
  /** Of a part script as built: what must hold that a param is of (each by what says it): what decides it. */
  partMustsOf({ address }) {
    return JSON.parse(current().part_musts_of(address));
  },
  /** Of a part script as built: how a node can move with all that must hold held: `{rank, dirs, params}`. */
  partWays({ address }) {
    return JSON.parse(current().part_ways(address));
  },
  /** Of a part script: a drag let go of (the next begins from as built); kept (`keep`): `{id, text, drags}` to write
   *  (`drags`: those kept before it), or null where nothing was dragged. */
  partGrabEnd({ keep, scratch }) {
    const t = current().part_grab_end(!!keep, !!scratch);
    return t ? JSON.parse(t) : null;
  },
  /** Of a part script: a reading kept beside it by `name` (`{what, within}`), or the one of that name let go (none):
   *  `{id, text}`, to write. */
  partReading({ name, reading }) {
    return JSON.parse(current().part_reading(name, reading == null ? undefined : JSON.stringify(reading)));
  },
  /** Of a part script, built: what is kept of how it was settled that is new, to keep (a list of `{id, text}`: each by its key,
   *  `settles/KEY.json`). */
  partSolved() {
    return JSON.parse(current().part_solved() || "[]");
  },
  /** Of a part script, built: what checking it finds wrong, `{ key, said, version }` (`said` null: said with the
   *  model already, kept of its settle); null where it is not a part script. */
  partChecks({ key } = {}) {
    const t = current(key).part_checks();
    return t ? { ...JSON.parse(t), version: versionOf(key) } : null;
  },
  /** Of a part script: what checking the settle of `key` found, kept with that settle where it is the one built. */
  partChecked({ key, said }) {
    current().part_checked(key, JSON.stringify(said));
  },
  imports({ source, id }) {
    return JSON.parse(wasm.module_imports(source, id));
  },
  newWorkspace({ name }) {
    return JSON.parse(wasm.new_workspace(name));
  },
};
// (One at a time, in the order asked.)
let last = Promise.resolve();
/** What each thing asked of it is, said in its log. */
const ASKED = {
  open: "opening the model", settle: "settling the model", drawnFile: "finding its sheets as drawn", setFiles: "building it again", scenario: "building another scenario", exclude: "leaving some load cases out of its checks",
  state: "saying how it is", settledOut: "handing out the settled model", adopt: "taking a settled model", drawn: "drawing its sheets", partChecks: "checking where its bodies meet", imports: "reading a file's imports",
  sceneCall: "using a tool of its scene", sceneState: "saying how its scene is", sceneReader: "reading its point cloud", sceneDraw: "drawing its point cloud", sceneRead: "reading its point cloud",
};
let asking = 0;
self.onmessage = (e) => {
  const { id, op, args } = e.data;
  asking++;
  last = last.then(async () => {
    const began = performance.now();
    // (What it is asked once a second, to see whether its state is new, is not a step of its work.)
    if (op !== "version") say(ASKED[op] ?? (op === "request" ? `asked: ${args?.op}` : `asked: ${op}`));
    try {
      await ready();
      if (!ops[op]) throw new Error(`unknown engine op ${op}`);
      if (!app && !models.size && !["open", "adopt", "has", "stamp", "build", "state", "version", "imports", "newWorkspace", "sceneTools"].includes(op)) throw new Error("no model open");
      const value = ops[op](args ?? {});
      // (Bytes handed over, not copied.)
      self.postMessage({ id, ok: true, value, ms: performance.now() - began }, value instanceof Uint8Array ? [value.buffer] : []);
    } catch (err) {
      self.postMessage({ id, ok: false, error: String(err?.message ?? err), ms: performance.now() - began });
    }
    // (Nothing more asked of it: it stops.)
    if (--asking === 0) say(null);
  });
};
