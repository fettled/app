import { closeDoc, defineType, openDoc, opensFor, retitle, setInfo } from "../shell/dock.js";
import { madeIn } from "./homes.js";
// The 3D views (glview.js) on the page: each in its pane with its own controls, a gizmo, the
// card of what is chosen and a proposal's strip; what a click, a drag and a right-click in one
// do; and which layers each draws.

import { $, el, esc, openMenu, store, stored } from "../ui.js";
import { did } from "../actions.js";
import { GLView, vec } from "../glview.js";
import { onPrefs, prefs, setPrefs } from "../prefs.js";
import { workspace } from "../workspace.js";
import * as objects from "../objects.js";
import { vis } from "../objects.js";
import { msg } from "../shell/panel.js";
import { active, allViews, hasPoints, sel, setActive, st, views, viewsOf } from "./state.js";
import { model, project } from "../project.js";
import { dirOf, nameOf, pathIn, workspaceOf } from "../ids.js";
import { choose, contextMenu, objectMenu, renderChips } from "./chosen.js";
import { openIssue } from "./issues.js";
import { canGoBack, canGoForward, copyViewLink, goBack, goForward, gotoIssue, gotoMembers, gotoObject, keepView } from "./links.js";
import { handleDrag, handleHover, handleMenu, objectAt, rebuildMarks } from "./marks.js";
import { kindOf } from "./kinds.js";
import { deflects, drawOverlay, overlayMarker, placeKeys, shapeOver } from "./overlay.js";
import { counted, markBalance, marksBalance, members, modelBounds, pickIn, pointAt, ratios, rebuildModel, selectMember, showMember } from "./parts.js";
import { primePoints, requestFree, requestSlab, pointsSeenIn, seenSel, showSelection, syncHighlights } from "./points.js";
import { drawPoint, drawing, endDrawing, startDrawing } from "./polylines.js";
import { placeDiffbar } from "./proposals.js";
import { hasSkeleton } from "./skeleton.js";
import { CLEAR, boxOf, canCutAway, cutAlong, heightsCut, leaveSlab, slabName, slabOf, syncSlabs, toggleHeights, updateSlab, viewSlab } from "./slabs.js";
import { leavePhoto, viewPhoto } from "./photos.js";
import { renderTree } from "./tree.js";
import { bodiesDrawn, displayExact, exactFor, exactIn, findExact, gizmoLook, modelLevels, partAt, pathOfBody, sectionExact } from "./exact.js";
import { doing, onLog } from "../times.js";
import { PICK_KINDS } from "./bodyparts.js";
import { bindGrab } from "./grab.js";
import { rayPick, rectangleSelection } from "./selecting.js";
import { outlining, startOutline, stopOutline } from "./outline.js";

/** Who else wants to know that a view has been drawn, which it is when its camera moves. None, for a page with no session. */
export const viewDrawn = new Set();
/** What else a view's toolbar has, put there by `f(v)` each time it is drawn: a session's button. None, for a page with no session. */
export const toolsAlso = new Set();

/** The key of a 3D view to open: the one last used (or any there is); `fresh`, or with none open: of a new one. */
export function viewKey(fresh) {
  const have = views[active] ?? Object.values(views)[0];
  if (have && !fresh) return have.key;
  let n = 1;
  while (views[n]) n++;
  return `view:${n}`;
}
/** The 3D view to act in: the one last used, else any; with none open, one is opened. */
// (What the viewer chooses of how views look, every view takes; the toolbars say what of it they show.)
onPrefs(({ display, gizmo, input, ...look }) => {
  for (const v of Object.values(views)) {
    if (display) { v.display = { ...display }; displayExact(v); }
    if (gizmo || input !== undefined) gizmoLook(v);
    v.set(look, true);
    renderTools(v);
  }
});

export function theView() {
  return views[active] ?? Object.values(views)[0] ?? openDoc(viewKey(true), { tab: true }).view;
}

/** What a new view is to be turned to once it is there (by its id): a thing of the scene it was opened for. */
const pending = {};
/** Turns a view to a thing of the scene: clipped to it, for a slab; else looking at it. */
function turnTo(v, kind, id) {
  setActive(v.name);
  if (kind === "slab") { choose("slab", id); viewSlab(id, v); } else if (kind === "photo") { choose("photo", id); viewPhoto(id, v); } else gotoObject(kind, id);
}
// A thing of the scene, dragged onto a pane or opened: onto a 3D view, that view is turned to it; else a new view is, once it is there.
opensFor("thing", (what, onto) => {
  const [kind, id] = [what.slice(0, what.indexOf(":")), what.slice(what.indexOf(":") + 1)];
  if (onto?.type === "view") { turnTo(onto.view, kind, id); return null; }
  const key = viewKey(true);
  pending[key.slice(5)] = { kind, id };
  return key;
});

/** The view's controls' button: sliders. */
const TOGGLE = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 4h12M2 8h12M2 12h12"/><circle cx="5" cy="4" r="1.6" fill="#16171b"/><circle cx="10.5" cy="8" r="1.6" fill="#16171b"/><circle cx="7" cy="12" r="1.6" fill="#16171b"/></svg>`;
/** A 3D view in a pane (by its id), with what is kept of how it looks: what the dock shows, and the view itself. */
function makeView(id, kept) {
  const pane = el("div", { class: "glpane" });
  const host = el("div", { class: "glhost" });
  const chip = el("div", { class: "glchip", hidden: "" });
  const bar = el("div", { class: "diffbar", hidden: "" });
  // Its own controls. (What it is turned by, a gizmo in its corner, and what is over it (overlay.js), the scene
  // draws: exact.js.)
  const tools = el("div", { class: "gltools" });
  // (What floats over it under its controls, a proposal's strip and whom it follows, one above another: never over each other.)
  const floats = el("div", { class: "viewfloats" });
  floats.append(bar);
  // (In a bubble, put away by its button: on a narrow page to begin with, where the view needs the room.)
  const toggle = el("button", { class: "gltoggle", title: "Show or hide the view's controls", "aria-label": "View controls" }, TOGGLE);
  const wide = () => window.innerWidth >= 760, wasKey = () => `fettled.view.tools.${wide() ? "wide" : "narrow"}`;
  const showTools = (yes) => { pane.classList.toggle("bare", !yes); toggle.setAttribute("aria-expanded", String(yes)); };
  showTools(stored(wasKey(), wide()));
  toggle.onclick = () => { const yes = pane.classList.contains("bare"); store(wasKey(), yes); showTools(yes); };
  // (What stands over its foot, at its left corner and its right, each one thing above another: its card, what is tried out
  // and what it has to say at the left; the root part it shows, a photo's bar and the keys of what is over it at the right.
  // All of it is put in one of the two, never placed by itself: so no two are over each other.)
  const foot = el("div", { class: "viewfoot" }), lowLeft = el("div", { class: "low-left" }), lowRight = el("div", { class: "low-right" });
  foot.append(lowLeft, lowRight);
  lowLeft.append(chip);
  pane.append(host, floats, foot, toggle, tools);
  const v = (allViews[id] = new GLView(host));
  Object.assign(v, { lowLeft, lowRight });
  // (Of the root part it was left showing; a new one, of the one focused. One not open yet is opened when the view is in sight:
  // `rootInSight`.)
  v.root = kept?.root ?? project.current();
  if (v.root === project.current()) views[id] = v;
  // (Which root part it shows, over it: chosen there, to show another.)
  const rootTag = el("button", { class: "glroot", title: "The root part this view shows: click to show another here" });
  rootTag.onclick = (e) => rootMenu(v, e);
  lowRight.append(rootTag);
  v.rootTag = rootTag;
  // (While its root part is opened, built or drawn: said over it, with what is being done.)
  const loading = el("div", { class: "glloading", hidden: "" });
  pane.append(loading);
  v.loading = loading;
  // (A part script's bodies, drawn exactly under it where the page can.)
  exactFor(v);
  Object.assign(v, { name: id, key: `view:${id}`, pane, chip, diffbar: bar, floats, tools, slab: kept?.slab ?? null, display: { ...prefs().display }, pickKind: kept?.pickKind ?? "part", skeleton: !!kept?.skeleton, deflected: !!kept?.deflected });
  // (How the viewer has chosen views look: theirs, not the view's kept state's.)
  const { display: _, gizmo: __, input: ___, ...look } = prefs();
  v.set(look, true);
  // (The model's parts are picked where they are drawn.)
  const pickable = () => v.state.layers.model;
  v.onPoint = (ray) => pointAt(ray, v);
  v.onDraw = () => { placeKeys(v); for (const f of viewDrawn) f(v); };
  v.onMarker = (ev) => overlayMarker(ev);
  // What the cursor is over says what it is (as the scene says what its markers are: it draws both).
  let hovering = 0;
  host.addEventListener("pointermove", (e) => {
    if (e.buttons || e.target !== v.canvas) return;
    cancelAnimationFrame(hovering);
    hovering = requestAnimationFrame(() => {
      const r = v.canvas.getBoundingClientRect(), m = pickable() && partAt(v, v.ray(e.clientX - r.left, e.clientY - r.top));
      // (No members while the model has not been built here: one waiting to be settled where its points are, one whose
      // script is in error. Its bodies as last drawn are still under the cursor.)
      const part = m && members?.find((x) => x.path === m.path), used = part && ratios[part.path];
      v.sceneTip(part ? `${part.label}${used ? ` · ${used.ratio.toFixed(2)} ${used.title.toLowerCase()} (${used.combination})` : ""}` : null);
      sel.hover = part?.path ?? null;
    });
  });
  host.addEventListener("pointerleave", () => { cancelAnimationFrame(hovering); v.sceneTip(null); if (sel.hover) { sel.hover = null; drawOverlay(v); } });
  pane.addEventListener("pointerdown", () => useView(v), true);
  v.onHandle = (id, phase, ray, e) => handleDrag(v, id, phase, ray, e);
  v.onHandleMenu = (id, e) => handleMenu(v, id, e);
  v.onHandleHover = (id, on) => handleHover(v, id, on);
  v.onLine = (a, b) => cutAlong(v, a, b);
  v.onChange = () => {
    requestFree(v);
    renderLayers();
  };
  v.onLabel = (id) => openIssue(id);
  // Double-click a pin: this view goes to its place (Back returns).
  v.onLabelZoom = (id) => gotoIssue(id, v);
  const pickAt = async (ray, e) => {
    if (drawing) return drawPoint(v, ray, e);
    // Of a part script's bodies, what the view's selection says: a face, an edge, a vertex of one, or a node.
    if (exactIn(v) && v.pickKind !== "part" && e) {
      // (What the view is told is a pointer's place on the page, as Pangolino said it: no offset of its own.)
      const box = v.canvas.getBoundingClientRect(), [x, y] = [e.clientX - box.left, e.clientY - box.top];
      const seen = findExact(v, x, y, v.pickKind);
      // (A face, an edge or a vertex: what the workspace's ray from the view meets nearest, as an agent's; the view's own
      // pick says more of it, where it is the same. A node, the view's.)
      const kinds = { face: "faces", edge: "edges", vertex: "vertices" };
      if (!kinds[v.pickKind]) return void choose(seen ? "bodypart" : null, seen);
      const f = (await rayPick(v, x, y, [kinds[v.pickKind]], { px: 8 }))[0];
      if (!f) return void choose(null, null);
      const cut = f.address.lastIndexOf(":"), address = f.address.slice(0, cut), name = f.address.slice(cut + 1);
      const same = seen && seen.address === address && seen.what === f.what && seen.index === f.index;
      return void choose("bodypart", same ? seen : { what: f.what, address, index: f.index, name, at: f.at });
    }
    // On the lines of a slab, a plane or a polyline: that is what is meant.
    const o = !e?.altKey && objectAt(v, e);
    if (o) return choose(o.kind, o.id);
    const cuts = v.cuts();
    // What is nearest along the ray, of the points drawn and the parts (one question of the workspace, as an agent's
    // `select` asks it: selecting.js); with alt, of the points alone.
    const box = v.canvas.getBoundingClientRect();
    const [x, y] = e ? [e.clientX - box.left, e.clientY - box.top] : [0, 0];
    const of = !e?.altKey && pickable() ? ["points", "parts"] : ["points"];
    const first = e && (pointsSeenIn(v) || of.length > 1) ? (await rayPick(v, x, y, of))[0] : null;
    const onPoint = !!first && first.address.includes("#");
    // (Of a point: what the point cloud says of it there. Of the point cloud, only where it is drawn.)
    const r = onPoint || !e ? await workspace.pick(ray.origin, ray.dir, cuts.z, cuts.slab, v.pixelSize()) : { hit: null, selections: [] };
    // What is drawn there is what is selected: a shown selection's points; else the nearest, the part or the point.
    const selId = !e?.altKey && (r.selections || []).find((id) => { const s = st.selections.find((x) => x.id === id); return s && seenSel(s); });
    const onMember = first && !onPoint ? pathOfBody(first.address) : null;
    if (selId) choose("selection", selId);
    else if (onMember) { selectMember(onMember); if (r.hit) { sel.at = r; renderChips(); rebuildMarks(); } }
    else {
      // (A point of a point cloud: its card says how the points are drawn.)
      choose(r.hit ? "point" : null, r.hit ? { ...r, ofPoints: true } : null);
      // The member near it fills the Member tab (without leaving the tab you are on).
      if (r.member) showMember(r.member.path);
    }
  };
  v.onPick = pickAt;
  // Right-click: pick what is there, then offer what can be done with it.
  v.onContext = async (ray, e) => {
    // (Looking at what is there does not change what is selected.)
    const o = objectAt(v, e);
    if (o) return openMenu(objectMenu(o.kind, o.id, v), e.clientX, e.clientY);
    contextMenu(v, await pickIn(v, ray), e.clientX, e.clientY, ray);
  };
  host.addEventListener("dblclick", async (e) => {
    if (e.target !== v.canvas) return;
    if (drawing) return endDrawing(true);
    // On what is looked through (a slate of a frame of a recording, a photo's mark, someone's in a session): that is done.
    const frame = !e.altKey && objectAt(v, e);
    if (frame && kindOf(frame.kind).lookThrough) return kindOf(frame.kind).goto(frame.id);
    // On a part of the model: this view goes to it, as a second click on its row in the tree does (Back returns).
    const box = v.canvas.getBoundingClientRect(), px = [e.clientX - box.left, e.clientY - box.top];
    const picked = !e.altKey && pickable() ? await rayPick(v, ...px, ["parts"]) : [];
    const on = picked[0] && pathOfBody(picked[0].address);
    if (on) return gotoMembers(on, v);
    const p = sel.pick ?? sel.at;
    if (p?.hit) v.centreOn(p.hit);
  });
  // A window dragged with shift: the points in it become a selection, said as the view's camera saw them (an outline of
  // its picture: everything in its cone, whatever is in front), and in a view clipped to a slab, only the slab's
  // (selecting.js). Kept as it is said, it is found again as the model is.
  v.onSelect = async (w) => {
    if (!hasPoints()) return;
    const cam = v.camera();
    if (!cam) return;
    const at = (nx, ny) => [(nx + 1) * 0.5 * cam.w, (1 - ny) * 0.5 * cam.h];
    const selection = rectangleSelection(v, at(w.rect[0], w.rect[1]), at(w.rect[2], w.rect[3]));
    if (!selection) return;
    const r = await workspace.call("selections", { action: "said", ...madeIn(), selection, root: "" });
    if (r.error) return setInfo(v.key, r.error);
    const made = r.text.match(/selected (s\d+)/)?.[1];
    if (made) showSelection(made);
  };
  // As it was left; else as the others are (against a point cloud's points, on the dark; alone, on paper).
  if (kept?.state) v.set(kept.state, true); else v.set({ paper: !hasPoints() }, true);
  v.framed = !!kept?.state;
  if (views[id]) primeView(v);
  renderRoots();
  // (A node of a part script's, dragged: before whatever else in the view can be.)
  bindGrab(v);
  const to = pending[id];
  delete pending[id];
  if (to) setTimeout(() => turnTo(v, to.kind, to.id), 0);
  return {
    el: pane, view: v,
    shown: () => { setActive(id); if (st) { syncSlabs(); rebuildMarks(); } renderLayers(); v.redraw(); rootInSight(v); },
    dispose: () => {
      // (What stood over it that is not its own, the skeleton's key and the deflected shape's scale, is kept.)
      for (const e of pane.querySelectorAll("#struct3d, #deflect3d, #scratch3d")) { e.hidden = true; $("parked").append(e); }
      delete views[id];
      delete allViews[id];
      if (active === id) setActive(Object.keys(views)[0] ?? null);
      renderRoots();
      v.exactView?.view.free();
    },
    keep: () => ({ state: v.get(), root: v.root, slab: v.slab, pickKind: v.pickKind, skeleton: v.skeleton, deflected: v.deflected }),
    // (Gone back to: it moves to how it was, in sight; of the root part it was of.)
    update: (k) => { if (!k) return; if (k.root && k.root !== v.root) showRoot(v, k.root); v.slab = k.slab; v.animate(k.state); syncSlabs(); },
  };
}
const viewTitle = (id) => {
  const v = allViews[id], sb = v === views[id] ? slabOf(v?.slab) : null;
  if (!v?.root) return "3D view";
  const same = Object.values(allViews).filter((x) => x.root === v.root).map((x) => x.name).sort((a, b) => a - b), n = same.indexOf(v.name);
  return `${rootName(v.root)} (3D)${n > 0 ? ` ${n + 1}` : ""}${sb ? ` · slab ${slabName(sb)}` : ""}${v.state.photo ? ` · through ${v.state.photo.name}` : ""}`;
};
defineType("view", {
  // (By the root part it shows: "bike (3D)"; of several views of it, the second "bike (3D) 2", and so on; clipped to a slab, said.)
  title: viewTitle,
  // (Through a photo: which, as a chip of its own that leaves it, apart from the tab's own close.)
  label: (id) => {
    const v = allViews[id], p = v?.state.photo;
    if (!p) return esc(viewTitle(id));
    const base = esc(viewTitle(id).replace(` · through ${p.name}`, "")), short = p.name.split(".").slice(1).join(".") || p.name;
    return `${base} <b class="leavephoto" data-leave-photo="${esc(id)}" title="Through ${esc(p.name)}: click to go back to the model in 3D (Back looks through it again)">${esc(short)} ✕</b>`;
  },
  make: makeView,
  // (One 3D view is not put in place of another: each is looked at as it was left.)
  replaces: false,
});

// ----- which root part a view shows ----------------------------------------------------------------

/** A root part's name, as a view says it: its file's, or its folder's for a folder's model. */
export const rootName = (entry) => {
  const n = nameOf(entry);
  if (n !== "model.ts") return n.replace(/\.ts$/, "");
  const d = pathIn(dirOf(entry));
  return d ? d.split("/").pop() : workspaceOf(entry) ?? "model";
};
/** Whether the views show more than one root part: then each says which, and those of the focused one are marked. */
const manyRoots = () => new Set(Object.values(allViews).map((v) => v.root)).size > 1;
/** Each view's tag of its root part, and the mark on those of the one focused; the tabs' names. */
export function renderRoots() {
  const many = manyRoots(), now = project.current();
  for (const v of Object.values(allViews)) {
    const focus = v.root === now;
    v.pane.classList.toggle("rootfocus", many && focus);
    v.pane.classList.toggle("rootaway", many && !focus);
    v.rootTag.hidden = !v.root;
    v.rootTag.textContent = v.root ? rootName(v.root) : "";
    v.rootTag.title = `${v.root ?? ""}: the root part this view shows${many ? (focus ? " (focused: the tree, params and card are of it)" : " (a click in the view focuses it)") : ""}. Click to show another here`;
  }
  retitle();
}
/** A view used (a pointer down in it): it is the one acted in, and its root part the one focused. */
export function useView(v) {
  if (v.root && v.root !== project.current()) project.focus(v.root);
  if (active !== v.name && views[v.name]) { setActive(v.name); renderLayers(); drawOverlay(v); }
}
/**
 * A view shows another root part of the workspace (by its id), in place of the one it showed: opened where it is not (and kept
 * open), and focused, the view being the one acted in. Nothing else is built again: a root part open already is as it was left.
 */
/** What of how a view looks is of the root part it shows: where its camera is, the box it is cut to, whether it is held square
 *  on, a photo looked through, and the slab it is clipped to. */
const LOOK = ["camera", "box", "flat", "photo"];
/** Where that is kept, of each root part a view has left, for this workspace, in this browser. */
const looksKey = () => `fettled.rootlooks:${project.home() ?? ""}`;
/** How a view looks of the root part it shows, kept with that root part (in place of what was kept of it): for a view that is
 *  turned to it again to look so. */
function keepLook(v) {
  if (!v.root) return;
  const s = v.get(), all = stored(looksKey(), {});
  all[v.root] = { state: Object.fromEntries(LOOK.filter((k) => k in s).map((k) => [k, s[k]])), slab: v.slab ?? null };
  store(looksKey(), all);
}
/** A view turned to a root part looks as a view of it was left, where one was: whether it does. */
function takeLook(v, entry) {
  const l = stored(looksKey(), {})[entry];
  if (!l) return false;
  v.set(l.state, true);
  v.slab = l.slab;
  return true;
}
export async function showRoot(v, entry, { keepCamera = false } = {}) {
  if (!entry || v.root === entry) { useView(v); return; }
  // (Not open: opened, and the view turned to it at once, before it is: what it showed goes, and the page says it is opening.)
  const opening = project.root(entry) ? null : project.open(entry);
  // (Of another model: as a view of it was left, where one was; else looked at whole, once it is drawn. Its camera kept where it
  // follows someone: it is theirs. What it was clipped to, and its marks, were of the other: kept with that one, for coming
  // back to it.)
  keepLook(v);
  v.root = entry;
  v.modelName = null;
  v.slab = null;
  setInfo(v.key, "");
  // (What it drew of the other goes at once, not once this one's model is said.)
  if (v.exactView?.view) { v.exactView.view.show("[]"); v.exactView.other = null; v.drawnOf = null; v.redraw(); }
  v.framed = keepCamera || takeLook(v, entry);
  // (Of the root part focused: given what the others have. Of another: focused, and given it as its model is said.)
  if (entry === project.current()) { views[v.name] = v; setActive(v.name); exactFor(v); primeView(v); }
  else { delete views[v.name]; project.focus(entry); setActive(v.name); exactFor(v); }
  for (const f of rootShown) f(v);
  renderRoots();
  renderLayers();
  const r = await opening;
  if (r?.error) msg(`${entry} could not be opened: ${r.error}`, true);
}
/** A view in sight, of a root part not open yet: it is opened (and drawn in the view once it is). After what else is being laid
 *  out, which may turn the view to another (`showRootInAddress`). */
function rootInSight(v) {
  setTimeout(() => {
    if (!allViews[v.name] || !v.root || project.root(v.root)) return;
    project.open(v.root).then((r) => { if (r.error) setInfo(v.key, `${nameOf(v.root)} could not be opened: ${r.error}`); renderRoots(); });
  });
}
/** The root part the page's address names (the one focused) shown in a view: where none of the views laid out as they were left
 *  shows it, the first of them is turned to it (in place of one that would be opened for nothing). */
export function showRootInAddress() {
  const now = project.current(), all = Object.values(allViews);
  if (!now || !all.length || all.some((v) => v.root === now)) return;
  const v = all[0];
  keepLook(v);
  v.root = now;
  v.slab = null;
  v.framed = takeLook(v, now);
  views[v.name] = v;
  setActive(v.name);
  exactFor(v);
  primeView(v);
  renderRoots();
}
/**
 * Says over a view, while the root part it shows is not drawn in it as it now is: that it is being opened, built or drawn, by
 * name, and what is being done (its latest step, as the build log has it). Nothing, once its bodies of the build it is at are
 * drawn in the view (or where the view cannot draw them).
 */
function renderLoading(v) {
  const r = v.root && project.root(v.root), s = r?.state, name = v.root ? rootName(v.root) : "";
  const what = !r ? null : r.solving ? `Building ${name}` : !s || s.opening ? `Opening ${name}` : r.built && v.exactView?.view && v.drawnOf !== s.version ? `Drawing ${name}` : null;
  const now = what ? doing() : {}, of = (source) => now[`${source}${r.also}`];
  const step = what && (of("solver") ?? of("model") ?? of("page"));
  v.loading.hidden = !what;
  if (what) v.loading.innerHTML = `<i></i><span>${esc(what)}${step ? ` <span class="muted">· ${esc(step)}</span>` : ""}…</span>`;
}
const renderAllLoading = () => { for (const v of Object.values(allViews)) renderLoading(v); };
onLog(renderAllLoading);
bodiesDrawn.add(renderLoading);
project.onFocus(renderAllLoading);
/** Who else wants to know that a view shows another root part: a session's following. */
export const rootShown = new Set();
/** The root parts a view can be turned to: those open, then the workspace's other parts. */
async function rootMenu(v, e) {
  const open = project.roots().map((r) => r.entry), files = (await project.sources()).files ?? [];
  const parts = files.map((f) => f.path).filter((p) => isRootFile(p) && !open.includes(p));
  const item = (entry) => ({ label: `${entry === v.root ? "✓ " : ""}${rootName(entry)}`, title: entry, run: () => showRoot(v, entry) });
  openMenu([{ label: "Show in this view", cls: "head" }, ...open.map(item), ...(parts.length ? [null, { label: "Open here", cls: "head" }, ...parts.map(item)] : [])], e.clientX, e.clientY);
}
/** Whether a file can be a root part (a part script, not what is kept beside one). */
export const isRootFile = (path) => path.endsWith(".ts") && !/\.(gen|plans|measured|sightings|d)\.ts$/.test(path);
// Another root part focused: the views are those of it, the one acted in among them, and what is drawn over them is of it.
project.onFocus((r) => {
  viewsOf(r.entry);
  if (!views[active]) setActive(Object.keys(views)[0] ?? null);
  // (What was chosen was of the other: let go of. What is drawn of it comes as its model is said, next.)
  choose(null, null, false);
  renderRoots();
});
// A root part closed: its views closed with it; where they are all the views there are, the first turned to the root part focused.
project.onClose((r) => {
  const of = Object.values(allViews).filter((v) => v.root === r.entry), rest = Object.keys(allViews).length - of.length;
  for (const [k, v] of of.entries()) {
    if (rest === 0 && k === 0) showRoot(v, project.current());
    else closeDoc(v.key);
  }
  renderRoots();
});
// (Its model built, a view of it not yet drawing it: it is.)
model.onChange(() => { renderRoots(); renderAllLoading(); });

/** Gives a view just made what the others have: the points, the model's parts, the marks; and looks at the model. */
function primeView(v) {
  primePoints(v);
  syncLayers();
  if (!st) return;
  syncSlabs(); rebuildModel(); rebuildMarks(); syncHighlights(); renderChips(); shapeOver();
  const b = !v.framed && !v.slab && modelBounds();
  if (b) { v.framed = true; v.frame(b.centre, b.radius, 0); }
  setInfo(v.key, v.slab ? "" : counted);
  renderTools(v);
}

// What is shown, apart from what is chosen. Every object and every group of the tree has an eye: whether it is drawn (objects.js keeps
// which). That is separate from selecting it (clicking it), which says what the chip, the
// Member tab and a new issue refer to.

/** Which of a view's layers are drawn: the points where there are any and they are shown; the model's parts. */
export function syncLayers() {
  for (const v of Object.values(views)) v.set({ layers: { points: vis("pointclouds") && hasPoints(), model: true, marks: true, issues: true } }, true);
}
/** What is shown has changed: the views are drawn again. */
export function applyVisibility() {
  syncLayers();
  rebuildModel(); rebuildMarks(); syncHighlights();
  // (Each point cloud's eye: its cloud drawn or not.)
  for (const v of Object.values(views)) { renderTools(v); v.redraw(); }
}
export const toggleVis = (key) => objects.toggle(key);

// A view's own controls: in the view, over it.
const svg = (d, extra = "") => `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">${extra}<path d="${d}"/></svg>`;
const ICON = {
  whole: svg("M3 3l10 10 M13 3L3 13"),
  noroof: svg("M3.5 8v5.5h9V8", `<path d="M2 8l6-5 6 5" stroke-dasharray="1.6 1.8"/>`),
  back: svg("M10 3L5 8l5 5"),
  fwd: svg("M6 3l5 5-5 5"),
  square: svg("M3 3h10v10H3z M8 5.5v5 M5.5 8h5"),
  lock: svg("M4.5 7.5h7v5.5h-7z M6 7.5V5.5a2 2 0 0 1 4 0v2"),
  line: svg("M2.5 12.5l4-7 4 4 3-6", `<circle cx="2.5" cy="12.5" r="1.1" fill="currentColor"/><circle cx="6.5" cy="5.5" r="1.1" fill="currentColor"/><circle cx="10.5" cy="9.5" r="1.1" fill="currentColor"/><circle cx="13.5" cy="3.5" r="1.1" fill="currentColor"/>`),
  free: svg("M2.5 13.5L8 3.5 M2.5 13.5L12 5.5 M2.5 13.5L13.5 9.5", `<circle cx="2.5" cy="13.5" r="1.3" fill="currentColor"/>`),
  skeleton: svg("M3 13L8 3l5 10 M5.2 8.5h5.6", `<circle cx="3" cy="13" r="1.2" fill="currentColor"/><circle cx="8" cy="3" r="1.2" fill="currentColor"/><circle cx="13" cy="13" r="1.2" fill="currentColor"/>`),
  deflected: svg("M2 5h12 M2 5c3 7 9 7 12 0", `<path d="M8 5v5" stroke-dasharray="1.5 1.5"/>`),
  balance: svg("M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11 M8 1v14 M1 8h14", `<path d="M8 8V2.5A5.5 5.5 0 0 1 13.5 8z M8 8v5.5A5.5 5.5 0 0 1 2.5 8z" fill="currentColor" stroke="none"/>`),
  solids: svg("M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z", `<path d="M8 1.8l5.5 3L8 7.8 2.5 4.8z" fill="currentColor" fill-opacity=".35" stroke="none"/>`),
  edges: svg("M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z M2.5 4.8L8 7.8l5.5-3 M8 7.8v6.4"),
  section: svg("M2.5 4.5h7v7h-7z M9.5 4.5l4-2.5v7l-4 2.5", `<path d="M6 1v14" stroke-dasharray="1.6 1.2"/>`),
  xray: svg("M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z M2.5 4.8L8 7.8l5.5-3 M8 7.8v6.4", `<path d="M2.5 11.2L8 8.2l5.5 3 M8 1.8v6.4" stroke-dasharray="1.2 1.4" opacity=".6"/>`),
  pickpart: svg("M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z M2.5 4.8L8 7.8l5.5-3 M8 7.8v6.4"),
  pickface: svg("M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z", `<path d="M8 7.8l5.5-3v6.4L8 14.2z" fill="currentColor" stroke="none"/>`),
  pickedge3: svg("M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z", `<path d="M8 7.8v6.4" stroke-width="3"/>`),
  pickvertex: svg("M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z", `<circle cx="8" cy="7.8" r="2.3" fill="currentColor"/>`),
  picknode: svg("M3 13L13 3", `<circle cx="8" cy="8" r="3" fill="var(--bg, #fff)"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/>`),
  outline: svg("M3 9c0-3.5 2.5-6 6-6s5 2 4.5 4.5-3 2.5-4.5 4.5-1.5 3-3.5 2.5S3 12 3 9z", `<circle cx="3" cy="9" r="1.1" fill="currentColor"/><circle cx="9" cy="3" r="1.1" fill="currentColor"/>`),
  cut: svg("M2 13L14 3", `<path d="M5 14.5l-3-1.5 1.5-3 M12.5 1.5l1.5 1.5-3 1.5" stroke-width="1"/>`),
};

export function renderTools(v) {
  const s = v.state, sb = slabOf(v.slab);
  // Not while one of its fields is being typed in.
  if (v.tools.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  const wasOpen = v.tools.querySelector("details.more")?.open;
  const btn = (a, icon, title, on) => `<button data-a="${a}" class="${on ? "on" : ""}" title="${title}">${icon}</button>`;
  // (What is of a point cloud's points is there only where there is a point cloud.)
  const scan = hasPoints(), picked = sel.member;
  // (The model's bodies, drawn exactly: their solids, their edges, x-ray; where the page draws them.)
  const bodies = exactIn(v), d = v.display ?? {};
  // (Its heights, where it is clipped to a plan; and whether it is cut to a box of its own, the roof taken away.)
  const lv = modelLevels(), roofOff = heightsCut(v);
  const cm = `${Math.round(CLEAR * 100)} cm`;
  const roofBtn = () => {
    const can = canCutAway(v);
    const title = roofOff
      ? "The view is cut away: cut to a box of its own (click it to drag its faces; Delete it, from its menu, to start again). Again, to show everything: the box is kept for next time"
      : v.heightsKept
        ? "Cut the view away again: to its box as it was left"
        : !can
          ? "Nothing in the view to cut away"
          : lv.roof != null
            ? `Take the roof away: the view cut to a box whose top is ${cm} under the roof's lowest part (parts cut open show their sections), chosen, so its faces can be dragged (its bottom up, to take the floor away too). Any slab can be used instead: "Use it for the view's cut-away", from its menu`
            : `Cut the view away: to a box over the bottom half of what it holds (parts cut open show their sections), chosen, so its faces can be dragged. Any slab can be used instead: "Use it for the view's cut-away", from its menu`;
    return `<button data-a="noroof" class="${roofOff ? "on" : ""}" ${can ? "" : "disabled"} title="${title}">${ICON.noroof}</button>`;
  };
  v.tools.innerHTML =
    // (Its projection, a view from a side or from above, and fitting it: the gizmo in its corner, and "O".)
    `${canGoBack(v) || canGoForward(v) ? `<span class="grp">${btn("goback", ICON.back, "Back: as this view was before the last link followed, or thing gone to, in it")}${canGoForward(v) ? btn("goforward", ICON.fwd, "Forward again") : ""}</span>` : ""}` +
    `<span class="grp">${bodies ? `${btn("solids", ICON.solids, "Solids: the bodies' faces", d.solids)}${btn("edges", ICON.edges, "Edges: the bodies' edges, and where round faces turn away. Without solids, what is behind them is removed", d.edges)}${btn("xray", ICON.xray, "X-ray: see what is hidden. Solids become ghosts; edges hidden behind are drawn faintly", d.xray)}${btn("nodes", ICON.picknode, "Nodes: the points the part's solves put, on a body or not (green: something is kept of where it is: a param of it, or a drag)", d.nodes)}${btn("section", ICON.section, "Section: the bodies cut exactly by the plumb plane through their middle, square to the way the view looks, the half toward you taken away (set as the view is when pressed)", !!v.section)}` : ""}${hasSkeleton() ? btn("skeleton", ICON.skeleton, "The skeleton: the structure's nodes, where its members meet and end, over this view", v.skeleton) : ""}${deflects() ? btn("deflected", ICON.deflected, "The deflected shape, exaggerated, for the load combination chosen in the checks", v.deflected) : ""}${btn("balance", ICON.balance, "Mark the middle of the weight of what is chosen (a part, or a group of them), seen through whatever is in front of it", marksBalance())}</span>` +
    (bodies ? `<span class="grp" title="What a click picks: a part, or a face, an edge or a vertex of a body, or a node (where the part's solves put a point: the skeleton shows them)">${PICK_KINDS.map((k) => btn(`pick:${k}`, ICON[k === "edge" ? "pickedge3" : `pick${k}`], { part: "Pick a part", face: "Pick a face of a body", edge: "Pick an edge of a body (seen; with x-ray, hidden ones too)", vertex: "Pick a vertex of a body (seen; with x-ray, hidden ones too)", node: "Pick a node: a point the part's solves put, on a body or not (shows them)" }[k], (v.pickKind ?? "part") === k)).join("")}</span>` : "") +
    `<span class="grp">${picked ? `<button data-a="only" title="Show only the part picked (again: show all). The same as a right-click on its eye in the tree">only this</button>` : ""}${objects.isolated() ? `<button data-a="all" title="Show every part again">show all</button>` : ""}</span>` +
    (sb && !sb.filter
      ? `<span class="grp">${btn("whole", ICON.whole, `Leave slab ${esc(slabName(sb))}: the view shows everything again (a slab is viewed again from the tree: double-click it)`)}${btn("square", ICON.square, "Look square on at the slab, fitted in the view")}${btn("flat", ICON.lock, "Held square on: a drag slides the view. Off: a drag turns it", s.flat)}${workspace.can("rays") ? btn("free", ICON.free, "Free space: where the scanner's rays pass in the slab, under the points. Brighter: more rays. Where it is dark, something was in the way, or nothing looked. It is made for what the view sees, a cell a pixel: zoom in for finer." + (s.free ? v.freeInfo ?? "" : ""), s.free) : ""}</span>` +
        `<span class="grp" title="The slab: its thickness (m), and stepping it back and forward by half of that">${btn("back", ICON.back, "Slab back (away from the viewer)")}<input type="number" step="0.05" min="0.01" value="${(2 * sb.half[2]).toFixed(2)}" data-a="thick">${btn("fwd", ICON.fwd, "Slab forward (toward the viewer)")}</span>`
      : "") +
    `<span class="grp">${scan ? btn("outline", ICON.outline, "Select by an outline: click its corners, or drag freehand; close it on its first corner (or Enter); drag a corner, or a run's middle to bend it; shift-click inside to start a hole. Kept as a selection of the points the view sees in it, or added to, taken from or within the selection chosen", outlining(v)) : ""}${btn("line", ICON.line, "Draw a polyline: click its points (on what is there, or in the slab seen square on)", drawing?.view === v.name)}${btn("cut", ICON.cut, "Cut a slab: drag a line across the building, seen from above, to look at what it cuts through", v.tool === "line")}</span>` +
    `<span class="grp">${roofBtn()}</span>` +
    `<details class="more" ${wasOpen ? "open" : ""}><summary title="Keeping this view">⋯</summary><div><button data-a="keep" title="Keep this view with the project, by a name: it is listed under Views, to open again">Keep this view…</button> <button data-a="link" title="A link to this view, of the project at this commit: to send to someone, or say in an issue. It opens the model, as it looks here">Copy a link to this view</button> <button data-a="copy" title="This view's direction, as a sheet's view takes it: to paste into a sheet(...) in the script">Copy the view for a sheet</button></div></details>`;
  // (Its menu is kept within the view: moved left by as much as it would go past the view's right edge.)
  const more = v.tools.querySelector("details.more"), place = () => {
    const m = more.querySelector(":scope > div");
    m.style.left = "0px";
    if (!more.open) return;
    const over = m.getBoundingClientRect().right - (v.pane.getBoundingClientRect().right - 8);
    if (over > 0) m.style.left = `${-over}px`;
  };
  more.ontoggle = place;
  place();
  const step = (g) => updateSlab(sb.id, { centre: vec.add(sb.centre, vec.scale(sb.axes[2], g * sb.half[2])) });
  const acts = {
    // (About what the view looks at, which keeps its place and size; "O" over the view, about what is under the cursor.)
    // (What is drawn of the bodies is the viewer's choice, in every view, and kept.)
    solids: () => setPrefs({ display: { ...v.display, solids: !v.display.solids } }),
    edges: () => setPrefs({ display: { ...v.display, edges: !v.display.edges } }),
    xray: () => setPrefs({ display: { ...v.display, xray: !v.display.xray } }),
    nodes: () => setPrefs({ display: { ...v.display, nodes: !v.display.nodes } }),
    section: () => {
      const whole = sectionExact(v, !v.section);
      if (whole) msg(`Not sectioned (a round face crosses the plane), shown whole: ${whole.split("\n").join(", ")}`, true);
    },
    skeleton: () => { v.skeleton = !v.skeleton; drawOverlay(v); },
    deflected: () => { v.deflected = !v.deflected; drawOverlay(v); shapeOver(); },
    balance: () => { markBalance(!marksBalance()); for (const o of Object.values(views)) if (o !== v) renderTools(o); },
    copy: () => copyView(v),
    keep: () => keepView(v),
    link: () => copyViewLink(v),
    goback: () => goBack(v),
    goforward: () => goForward(v),
    only: () => { if (sel.member) objects.isolate(`m:${sel.member}`); },
    all: () => objects.showAll(),
    square: () => v.squareOn(boxOf(sb)),
    flat: () => (s.flat ? v.set({ flat: false }) : v.squareOn(boxOf(sb))),
    free: () => { v.set({ free: !s.free }); requestSlab(v); },
    line: () => (drawing ? endDrawing(true) : startDrawing(v)),
    outline: () => (outlining(v) ? stopOutline() : startOutline(v)),
    cut: () => { v.tool = v.tool === "line" ? null : "line"; },
    noroof: () => toggleHeights(v, lv.roof),
    whole: () => leaveSlab(v),
    back: () => step(-1),
    fwd: () => step(1),
  };
  // (What a click picks, of a part script's bodies. Picking nodes shows them.)
  for (const k of PICK_KINDS) acts[`pick:${k}`] = () => { v.pickKind = k; if (k === "node" && !v.display?.nodes) setPrefs({ display: { ...v.display, nodes: true } }); };
  for (const b of v.tools.querySelectorAll("button[data-a]")) b.onclick = () => { did("view", b.dataset.a); acts[b.dataset.a](); renderTools(v); };
  const th = v.tools.querySelector("input[data-a=thick]");
  if (th) th.onchange = () => { if (Number(th.value) > 0) updateSlab(sb.id, { half: [sb.half[0], sb.half[1], Number(th.value) / 2] }); };
  for (const f of toolsAlso) f(v);
}

/** A view's direction as a sheet's view takes it (a direction in the model toward the viewer), copied to paste into the script. */
async function copyView(v) {
  const code = `iso(undefined, { from: [${vec.scale(v.camera().forward, -1).map((x) => x.toFixed(3)).join(", ")}] })`;
  try { await navigator.clipboard.writeText(code); msg(`Copied: ${code} — paste into a sheet(...) in your script (a direction in the model toward the viewer).`, false); }
  catch (_) { msg(`View: ${code}`, false); }
}

export function renderLayers() {
  renderTree();
  for (const v of Object.values(views)) { renderTools(v); placeDiffbar(v); }
  // (A view's name says the slab it is clipped to.)
  retitle();
}

// (A view's tab's way out of a photo: before the tab takes the press.)
document.addEventListener("pointerdown", (e) => {
  const id = e.target.closest?.("[data-leave-photo]")?.dataset.leavePhoto;
  if (!id) return;
  e.stopPropagation();
  e.preventDefault();
  leavePhoto(allViews[id]);
}, true);
