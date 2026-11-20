import { goTo } from "./links.js";
import { kind } from "./kinds.js";
import { rebuildMarks } from "./marks.js";
import { boxAbout, onPlane } from "./geom.js";
import { setInfo } from "../shell/dock.js";
import { homeMenu, homeOf, homeSeen, madeIn, saidIn, whySaid } from "./homes.js";
// What is of a model's points: the clouds drawn in the views (thinned; every point of a slab a
// view is clipped to; free space in it), selections of points and the planes fitted to them.

import { esc, until } from "../ui.js";
import { pointsLook } from "../prefs.js";
import { vec } from "../glview.js";
import { workspace } from "../workspace.js";
import { show, vis } from "../objects.js";
import { f3, hasPoints, sel, shared, st, views } from "./state.js";
import { choose } from "./chosen.js";
import { slabFrom, slabName, slabOf } from "./slabs.js";
import { renderTree } from "./tree.js";
import { renderTools } from "./views.js";
import { sayOnFace } from "./pointreadings.js";
import { sessionNamed } from "./sessions.js";
import { outlineOf, startOutline } from "./outline.js";

/** Which points the clouds drawn are of (false: none is drawn), and each point cloud's cloud (thinned), for a view opened
 *  later. */
export let cloudLoaded = false;
let thins = [];
/** Of the point clouds, what each is called in the tree (its eye's key), by its place among them. */
const cloudKey = (k) => `cloud:${k}`;
/** The session a point cloud is a part of (its address `SESSION/…`, a session's lidar), if it is one's: it is in the tree under it. */
const sessionOfCloud = (s) => { const n = s?.address?.includes("/") ? s.address.split("/")[0] : null; return n && sessionNamed(n) ? n : null; };
/** Whether a point cloud is drawn: its eye is on, and its session's if it is one's (a part of what is hidden is hidden). */
const cloudShown = (k) => { const n = sessionOfCloud(st.clouds?.[k]); return vis(cloudKey(k)) && (!n || vis("sessions", `session:${n}`)); };
/** The addresses of the point parts that are not drawn: what a view's pick does not meet. */
export const hiddenPointParts = () => (st.clouds ?? []).flatMap((s, k) => (cloudShown(k) ? [] : [s.address]));
/** Whether any of the point clouds is drawn in a view (its eye on, and the view's points layer): what is not drawn is not picked. */
export const pointsSeenIn = (v) => !!v.state.layers.points && (st.clouds?.length ? st.clouds.some((_, k) => cloudShown(k)) : vis("pointclouds"));
/** The places among the point clouds of those that are a session's, the tree's rows under it. */
export const cloudsOfSession = (name) => (st.clouds ?? []).flatMap((s, k) => (sessionOfCloud(s) === name ? [k] : []));
const mil = (n) => `${(n / 1e6).toFixed(1)}M`;
/** A point cloud's row in the tree: under its session (named there by the rest of its address), or among the model's scans. */
export function cloudRow(row, depth, k) {
  const s = st.clouds[k], n = sessionOfCloud(s);
  return row(depth, "pointcloud", cloudKey(k), n ? s.address.slice(n.length + 1) : s.address, { id: cloudKey(k), on: sel.pointcloud === cloudKey(k), note: s.loaded ? `${mil(s.used)} of ${mil(s.count)} points` : st.loading || "loading", title: `${s.address}: ${n ? `the session ${n}'s lidar, its points (in ${s.file}) placed where the session is` : `a point cloud, a part of the model made of the points in ${s.file}`}; its eye draws it or not. Click it to say how its points are drawn` });
}

/** Gives a view the points the others draw, each point cloud's drawn while its eye is on. */
export function primePoints(v) {
  v.cloudShown = (which) => cloudShown(Number(which.split(" ")[1] ?? 0));
  thins.forEach((c, k) => v.setCloud(`thin ${k}`, c));
}

/** The points not drawn (the project no longer names one). */
export function forgetPoints() {
  cloudLoaded = false;
  for (const v of Object.values(views)) { thins.forEach((_, k) => v.setCloud(`thin ${k}`, null)); for (const k of [...v.highlights.keys()]) v.setHighlight(k, null); }
  thins = [];
  selClouds.clear(); selRays.clear();
}

/** The thinned scan, as the workspace has it now (`key`: which points it is of); again when that changes. */
export async function loadCloud(key) {
  cloudLoaded = key;
  // (Each point cloud's, on its own.)
  const cs = await Promise.all(Array.from({ length: Math.max(1, st.clouds?.length ?? 0) }, (_, k) => workspace.cloud(k)));
  if (cs.some((c) => !c)) { cloudLoaded = false; return; }
  for (const v of Object.values(views)) thins.forEach((_, k) => v.setCloud(`thin ${k}`, null));
  thins = cs;
  for (const v of Object.values(views)) { primePoints(v); v.slabWant = null; requestSlab(v); }
  // (Selections' points are found again in it.)
  selClouds.clear(); selRays.clear();
  for (const v of Object.values(views)) for (const k of [...v.highlights.keys()]) v.setHighlight(k, null);
  syncHighlights();
}

/** How finely the points are drawn (`thin`), set: kept where this viewer's caches are. */
async function setThin(thin) {
  const r = await workspace.call("points_view", { thin });
  if (r.error) alert(r.error);
}

/** Every scan point in the slab a view is clipped to, where it is a slab's view (a box that only cuts the view, as its
 *  heights do, has none: the thinned points are cut to it as it is): fetched a moment after it stops changing, and
 *  drawn in place of the thinned ones in it. Till then the thinned points are cut to it as it now is. */
export function requestSlab(v) {
  requestFree(v);
  const s = slabOf(v.slab), box = v.state.box, want = box && s && !s.filter ? box : null, key = want ? JSON.stringify(want) : "";
  if (key === (v.slabWant ?? "") || !st?.points?.loaded) return;
  v.slabWant = key;
  clearTimeout(v.slabTimer);
  if (!want) { v.setCloud("slab", null); return setInfo(v.key, ""); }
  v.slabTimer = setTimeout(async () => {
    const c = await workspace.slabPoints(want);
    if (v.slabWant !== key) return;
    v.setCloud("slab", c, want);
    setInfo(v.key, c ? `slab ${slabName(s)} · ${c.count.toLocaleString()} points` : "");
  }, 200);
}

/**
 * Free space in the slab a view is clipped to (when it is switched on): where the rays pass in
 * it, as a picture over its middle plane. Made for the part of the slab the view sees, with a
 * cell for each of its pixels, and again when the view or the slab changes: zooming in sharpens it.
 */
export function requestFree(v) {
  const box = v.state.box;
  let want = null;
  // (Where the view is drawn: what it sees is the scene's camera's.)
  if (box && v.state.free && st?.points?.loaded && st.points.rays && v.camera()) {
    // What of the slab's middle plane the view sees: where the rays through its corners meet it.
    const W = v.canvas.clientWidth || 1, H = v.canvas.clientHeight || 1, dpr = window.devicePixelRatio || 1;
    let lo = [-box.h[0], -box.h[1]], hi = [box.h[0], box.h[1]];
    const pts = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => onPlane(box.c, box.n, v.ray(x, y)));
    // (Not for a view along the plane, or one that looks past it to the horizon: the whole slab then.)
    if (pts.every(Boolean) && v.state.camera.ortho != null) {
      const uv = pts.map((p) => { const q = vec.sub(p, box.c); return [vec.dot(q, box.u), vec.dot(q, box.v)]; });
      lo = lo.map((x, k) => Math.max(x, Math.min(...uv.map((p) => p[k]))));
      hi = hi.map((x, k) => Math.min(x, Math.max(...uv.map((p) => p[k]))));
    }
    if (hi[0] - lo[0] > 1e-3 && hi[1] - lo[1] > 1e-3) {
      // A cell a pixel: as fine as the view can show, no finer than 1 mm.
      const cam = v.camera(), perPx = cam.ortho ? (2 * cam.hh) / (H * dpr) : Math.max(hi[0] - lo[0], hi[1] - lo[1]) / (Math.max(W, H) * dpr);
      const cell = Math.max(perPx, 0.001, Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 2048);
      // (Snapped to cells, so a small move asks for the same picture.)
      const snap = (x, up) => (up ? Math.ceil : Math.floor)(x / (cell * 16)) * cell * 16;
      lo = lo.map((x, k) => Math.max(-box.h[k], snap(x, false))); hi = hi.map((x, k) => Math.min(box.h[k], snap(x, true)));
      const mid = [0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1])], half = [0.5 * (hi[0] - lo[0]), 0.5 * (hi[1] - lo[1])];
      want = { box: { ...box, c: vec.add(box.c, vec.add(vec.scale(box.u, mid[0]), vec.scale(box.v, mid[1]))), h: [half[0], half[1], box.h[2]] }, w: Math.max(1, Math.round((2 * half[0]) / cell)), h: Math.max(1, Math.round((2 * half[1]) / cell)), cell };
    }
  }
  const key = want ? JSON.stringify([want.box, want.w, want.h]) : "";
  if (key === (v.freeWant ?? "")) return;
  v.freeWant = key;
  clearTimeout(v.freeTimer);
  if (!want) return v.setImage(null);
  v.freeTimer = setTimeout(async () => {
    const f = await workspace.free(want.box, want.w, want.h);
    if (v.freeWant !== key) return;
    const b = want.box, at = (a, c) => vec.add(b.c, vec.add(vec.scale(b.u, a * b.h[0]), vec.scale(b.v, c * b.h[1])));
    v.setImage(f && f.max ? { ...f, corners: [at(-1, -1), at(1, -1), at(-1, 1), at(1, 1)] } : null);
    v.freeInfo = f ? ` Now in cells of ${want.cell >= 0.01 ? `${(want.cell * 100).toFixed(1)} cm` : `${(want.cell * 1000).toFixed(1)} mm`}, up to ${f.max.toLocaleString()} rays over one.` : "";
    renderTools(v);
  }, 150);
}
export const selName = (s) => `${s.id}${s.label ? " " + s.label : ""}`;
/** How many points a selection has, as the workspace has it; none of one a part's script says that says no count (its points are
 *  found as the model is, when they are asked for: "0" was shown of it, as if it had none). */
const selCount = (s) => (saidIn(s) && !s.count ? null : s.count.toLocaleString());
export const planeName = (s) => `${s.id}${s.name ? " " + s.name : ""}`;
const planeCorners = (s, grow = 0) => [[s.ext[0] - grow, s.ext[2] - grow], [s.ext[1] + grow, s.ext[2] - grow], [s.ext[1] + grow, s.ext[3] + grow], [s.ext[0] - grow, s.ext[3] + grow]].map(([a, b]) => vec.add(s.centre, vec.add(vec.scale(s.u, a), vec.scale(s.v, b))));

/// Makes a selection's points drawn (its eye on, and its group's).
export async function revealSelection(id) {
  show(`sel:${id}`, "selections");
  renderTree();
  await syncHighlights();
}
/// Selects a selection and shows its points (null: lets go).
export async function showSelection(id) {
  choose(id ? "selection" : null, id);
  if (id) await revealSelection(id);
}

/** Leaves a selection's points out of the point cloud for everyone (or puts them back): for points that are not of the building. */
async function ignoreSelection(s) {
  if (!s) return;
  const r = await workspace.call("selections", { action: "ignore", id: s.id, ignore: !s.ignored });
  if (r.error) alert(r.error);
}

/** The points seen through a member (their rays pass through it): a selection of them, shown with the rays. */
export async function seenThrough(path) {
  const r = await workspace.call("selections", { action: "through", member: path, ...madeIn() });
  if (r.error) return alert(r.error === "no points there" ? "No rays pass through this member." : r.error);
  const id = r.text.match(/selected (s\d+)/)?.[1];
  if (!id) return;
  await until(() => st?.selections?.some((s) => s.id === id));
  await showSelection(id);
}

/** Fits a plane (to a selection's points, or about a point) and keeps it. What the fit found is kept to read. */
export async function fitPlane(args) {
  const r = await workspace.call("fit_surface", { ...madeIn(), ...args, keep: true });
  if (r.error) return alert(r.error);
  const id = r.text.match(/kept as plane (p\d+)/)?.[1];
  if (!id) return;
  (sel.fits ??= {})[id] = r.text;
  show(`plane:${id}`, "planes");
  choose("plane", id);
}

export function gotoPlane(id) {
  const s = st.surfaces?.find((x) => x.id === id);
  if (!s) return;
  goTo(boxAbout(planeCorners(s)));
}
// (What is refused is said, and the thing stays chosen: it was let go of as if it were gone.)
const deletePlane = async (id) => { const r = await workspace.call("surfaces", { action: "delete", id }); if (r.error) return alert(r.error); if (sel.plane === id) choose(null); };

const deleteSelection = async (id) => { const r = await workspace.call("selections", { action: "delete", id }); if (r.error) return alert(r.error); if (sel.selection === id) choose(null); };
const nameSelection = async (id, label) => { const r = await workspace.call("selections", { action: "label", id, label: label.trim() }); if (r.error) alert(r.error); };

/** Goes to a selection: frames the view last used on its points (Back returns). */
export function gotoSelection(id) {
  const s = st.selections?.find((x) => x.id === id);
  if (!s) return;
  revealSelection(id);
  goTo(s);
}

// Selections shown (their eye is on) are drawn as highlighted points; loaded once each.
const selClouds = new Map(), selRays = new Map();
export async function syncHighlights() {
  const want = (st?.selections || []).filter(seenSel).map((s) => s.id);
  for (const v of Object.values(views)) for (const key of [...v.highlights.keys()]) if (!want.includes(key)) v.setHighlight(key, null);
  for (const id of want) {
    if (!selClouds.has(id)) selClouds.set(id, await workspace.selectionCloud(id));
    const c = selClouds.get(id);
    if (c) for (const v of Object.values(views)) if (!v.highlights.has(id)) v.setHighlight(id, c);
  }
}

/** Whether a selection's points, or a plane, are drawn: its eye and its group's are on, and its home is in sight (homes.js). */
export const seenSel = (s) => vis("selections", `sel:${s.id}`) && homeSeen(s, s.id === sel.selection);
const seenPlane = (s) => vis("planes", `plane:${s.id}`) && homeSeen(s, s.id === sel.plane);

// What a point cloud, a selection of its points and a plane are to the tree, the card, the menus and the views (kinds.js).
kind("pointcloud", {
  group: "pointclouds", order: 0,
  // (A point cloud is chosen by its row: its card says how its points are drawn.)
  field: "pointcloud",
  key: (id) => id,
  find: (id) => (st.clouds?.[Number(String(id).split(":")[1])] ? { id, name: st.clouds[Number(String(id).split(":")[1])].address } : null),
  title: (s) => s.name,
  // (The model's point clouds: each its row, its eye drawing it or not.)
  rows: (row, list) => {
    // (A session's lidar is under the session: here are the model's others.)
    const own = (st.clouds ?? []).flatMap((s, k) => (sessionOfCloud(s) ? [] : [k]));
    return own.length ? list("pointclouds", own.length === 1 ? "Point cloud" : "Point clouds", () => own.map((k) => cloudRow(row, 1, k)), { note: st.drawn ? `${mil(st.drawn)} points drawn` : st.loading || "loading", title: "The model's point clouds, each a part of it, placed where the model says (thinned for the 3D view; a view clipped to a slab draws every point in it)" }) : "";
  },
  menu(id, m) {
    m.showHide();
  },
  // (What Details says of it: its points, how they are thinned to draw, and those left out (its part's `minRange`, in
  // the script); how finely it is drawn, set there.)
  info: (s) => {
    const sc = st.points ?? {}, thin = sc.thin ?? 0.025, near = sc.min_range ?? 1;
    return {
      what: "A point cloud: the points a lidar saw, which the model is seen against", name: s.name,
      rows: [
        ["Points", sc.count ? `${(sc.used ?? sc.count).toLocaleString()} of ${sc.count.toLocaleString()} used` : st.loading || "loading"],
        ["Drawn", st.drawn ? `${st.drawn.toLocaleString()}: a point per ${(thin * 100).toFixed(1)} cm cube (a view clipped to a slab draws every point in it)` : st.loading || "loading"],
        ...(sc.ranged === false ? [] : [["Left out", `points nearer the sensor than ${near.toFixed(2)} m (whoever carried it)`]]),
      ],
      note: "How near its sensor its points are left out is its part's, in the script (`minRange`). Thinning again takes a few seconds.",
      actions: [
        { label: "Drawn a point per", field: { value: +(thin * 100).toFixed(2), step: 0.5, min: 0.5, max: 50, unit: "cm cube" }, title: "How finely the 3D view draws the points: one point per cube of this side. Smaller is finer and slower", run: (cm) => setThin(cm / 100) },
      ],
    };
  },
  card(s) {
    const look = pointsLook();
    return { label: "Point cloud", id: s.name, body: look.html, bind: look.bind };
  },
});
kind("selection", {
  field: "selection", group: "selections", order: 30,
  key: (id) => `sel:${id}`,
  find: (id) => st?.selections.find((s) => s.id === id) ?? null,
  title: (s) => `selection ${selName(s)}`,
  all: () => st?.selections ?? [],
  // (One a part's script says: marked so, among the project's. It is changed and removed in that script.)
  rowOf: (row, s, depth, opts) => row(depth, "selection", `sel:${s.id}`, selName(s), { ...opts, id: s.id, on: s.id === sel.selection, note: [saidIn(s) ? "in the script" : null, selCount(s), s.ignored ? "ignored" : null].filter(Boolean).join(" · "), title: saidIn(s) ? `${selName(s)}: the model's script says it, in the part ${saidIn(s)}. It is named, changed and removed there, not here` : s.ignored ? `${selName(s)}: its points are left out of those used (shown here in yellow while its eye is on)` : selName(s) }),
  rows(row, list) { const mine = st.selections.filter((s) => homeOf(s) === "project"); return hasPoints() || mine.length ? list("selections", "Selections", () => mine.map((s) => this.rowOf(row, s, 1)), { note: mine.length || "shift-drag" }) : ""; },
  where: (s) => [{ key: "selection", label: `Selection ${selName(s)}` }],
  // (The box its points are in, as the point cloud has them.)
  points: (s) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [0, 1, 2].map((a) => ((k >> a) & 1 ? s.max[a] : s.min[a]))),
  info: (s) => ({ what: s.how === "said" ? "Selection: points picked out by what it says (found again as the model is)" : "Selection: points of the point clouds, picked out", name: `Selection ${selName(s)}`, rows: [["Points", selCount(s) ?? "found as the model is, when they are shown"], ...(saidIn(s) ? [["Said in", `the script, by the part ${saidIn(s)}`]] : [])], note: s.ignored ? "Its points are left out of those used." : "" }),
  refer: (s) => s.id,
  goto: gotoSelection,
  menu(id, m) {
    // (One a part's script says: what would change it is the script's to do, and says so.)
    const s = this.find(id), said = saidIn(s) ? whySaid(s) : null;
    m.issue("New issue on this selection");
    said ? m.off("Name it…", said) : m.name();
    m.add("Go to it", () => gotoSelection(id));
    m.add("Fit a plane to it", () => fitPlane({ selection: id }));
    m.add("Its points are on a face of the model…", () => sayOnFace(id), "", "Then click the face they are on: a reading of them on it is kept beside the model (NAME.pointreadings.gen.ts), and the model is built again, whatever of where that part is free moving to meet them");
    m.add("Slab around it", () => slabFrom({ selection: id }));
    // (One said by an outline: edited where it was drawn, through its photo or from where the view was.)
    const o = outlineOf(s);
    if (o && !said) m.add("Edit its outline…", async () => startOutline((await import("./views.js")).theView(), o), "", "Its outline over the view, in the camera it was drawn in (through its photo, or the view put back where it was): drag its corners, bend its runs, then keep it in its place");
    if (said) m.off(s?.ignored ? "Use its points again" : "Ignore its points", said);
    else m.add(s?.ignored ? "Use its points again" : "Ignore its points", () => ignoreSelection(s), "", s?.ignored ? "Its points are used again, for everyone (the points are read again)" : "Left out of the point cloud for everyone: not drawn, not picked, not counted as evidence. For points that are not of the building (reflections, something that was moved). The selection stays, marked ignored; \"Use its points again\" puts them back. The points are read again");
    m.showHide();
    homeMenu(m, "selection", s, id);
    m.divider();
    said ? m.off("Delete it", said) : m.add("Delete it", () => deleteSelection(id), "danger");
  },
  card: (s) => ({
    label: "Selection", id: s.id, ...(saidIn(s) ? { note: s.label } : { name: { text: s.label, save: (t) => nameSelection(s.id, t) } }),
    body: `${selCount(s) ? `${selCount(s)} points` : "said in the script"}${seenSel(s) ? "" : " · hidden"}${s.ignored ? " · <b>ignored</b>: left out of the points used" : ""}`,
  }),
  // The one chosen, if it is of points seen through a member: their rays from the sensor.
  marks(out) {
    const s = sel.selection && this.find(sel.selection);
    if (s?.how !== "through" || !seenSel(s)) return;
    if (!selRays.has(s.id)) { selRays.set(s.id, []); workspace.selectionRays(s.id).then((r) => { selRays.set(s.id, r); rebuildMarks(); }); }
    for (const [a, b] of selRays.get(s.id)) out.line(a, b, [255, 110, 80]);
  },
});
kind("plane", {
  field: "plane", group: "planes", order: 40,
  key: (id) => `plane:${id}`,
  find: (id) => st?.surfaces.find((s) => s.id === id) ?? null,
  title: (s) => `plane ${planeName(s)}`,
  all: () => st?.surfaces ?? [],
  rowOf: (row, s, depth, opts) => row(depth, "plane", `plane:${s.id}`, planeName(s), { ...opts, id: s.id, on: s.id === sel.plane, note: `${(s.rms * 1000).toFixed(0)} mm` }),
  rows(row, list) { const mine = st.surfaces.filter((s) => homeOf(s) === "project"); return hasPoints() || mine.length ? list("planes", "Planes", () => mine.map((s) => this.rowOf(row, s, 1)), { note: mine.length || "right-click: fit" }) : ""; },
  where: (s) => [{ key: "plane", label: `Plane ${planeName(s)}` }],
  points: (s) => planeCorners(s),
  frame: (s) => ({ origin: s.centre, axes: [s.u, s.v, s.normal] }),
  info: (s) => ({ what: "Plane: fitted to points of the point clouds", name: `Plane ${planeName(s)}`, rows: [["Facing", f3(s.normal)], ["Points", s.count.toLocaleString()], ["How well they lie on it", `${(s.rms * 1000).toFixed(1)} mm rms`], ...(s.describes ? [["Describes", s.describes]] : [])] }),
  refer: (s) => s.id,
  goto: gotoPlane,
  menu(id, m) {
    m.issue("New issue on this plane");
    m.name();
    m.add("Go to it", () => gotoPlane(id));
    if (shared()) m.add("Slab on it", () => slabFrom({ plane: id }));
    m.showHide();
    homeMenu(m, "plane", this.find(id), id);
    m.divider();
    m.add("Delete it", () => deletePlane(id), "danger");
  },
  card: (s) => ({
    label: "Plane", id: s.id, name: { text: s.name, save: (t) => workspace.call("surfaces", { action: "label", id: s.id, label: t }) },
    body: `facing ${f3(s.normal)} · ${s.count.toLocaleString()} points, rms ${(s.rms * 1000).toFixed(1)} mm · ${(s.ext[1] - s.ext[0]).toFixed(2)} × ${(s.ext[3] - s.ext[2]).toFixed(2)} m` +
      (sel.fits?.[s.id] ? `<details><summary>What the fit found</summary><pre>${esc(sel.fits[s.id])}</pre></details>` : ""),
  }),
  // Each as its patch's outline; the one chosen crossed and filled.
  marks(out) {
    for (const s of st.surfaces) {
      if (!seenPlane(s)) continue;
      const q = planeCorners(s), on = s.id === sel.plane, rgb = on ? [200, 255, 250] : [40, 210, 200];
      for (let i = 0; i < 4; i++) out.line(q[i], q[(i + 1) % 4], rgb);
      if (on) { out.line(q[0], q[2], rgb); out.line(q[1], q[3], rgb); out.fill(q, [60, 230, 215, 56]); }
    }
  },
  near(test) {
    for (const s of st.surfaces) if (seenPlane(s)) test.loop(s.id, planeCorners(s), true);
  },
});
