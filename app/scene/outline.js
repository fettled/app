// The outline editor (docs/points-and-selections-plan.md, "The outline editor"): an outline drawn over a view, in the
// picture of its camera as it was when drawing began (the view is held still meanwhile), kept as a selection said: the
// points the camera sees inside it. Loops of runs: the first the outside, the rest its holes.
//
// Making: click corners; press and drag to draw freehand (fitted to straight runs within a pixel or two); click the first
// corner, double-click or Enter to close the loop. Shift-click starts another loop (inside a closed one, a hole). Editing: drag a corner;
// drag a run's middle to bend it into an arc (alt: straight again); double-click a run to put a corner on it; Delete or
// Backspace over a corner takes it away. Ctrl/Cmd-Z undoes a step. Escape lets it go. Kept: as a new selection, or added
// to, taken from or intersected with the selection chosen (each a set of sets: `union`, `difference`, `intersection`); an
// outline of a selection kept, edited, is said again in its place.

import { workspace } from "../workspace.js";
import { madeIn } from "./homes.js";
import { setInfo } from "../shell/dock.js";
import { sel, st } from "./state.js";
import { photoNamed } from "./photos.js";
import { cameraOf } from "./selecting.js";
import { showSelection } from "./points.js";
import { esc } from "../ui.js";

const NS = "http://www.w3.org/2000/svg";
let editing = null;

/** Whether a view is having an outline drawn over it. */
export const outlining = (v) => editing?.v === v;

/** Begins an outline over a view: a new one, or (`of`: a selection kept, `where` its outline) one to edit, in the camera it
 *  was drawn in (through its photo, which the view is to look through; or from where the view was, which it is put back to,
 *  its picture scaled to the canvas as it is now). */
export async function startOutline(v, of = null) {
  if (editing) stopOutline();
  const said = of?.where.in;
  if (said && typeof said.frame === "string" && photoNamed(v.state.photo?.name)?.address !== said.frame) return setInfo(v.key, `Its outline was drawn through ${said.frame}: look through it to edit it`);
  if (said && typeof said.frame !== "string") {
    // (Back where it was drawn from, looking the same way.)
    const { origin, axes } = said.frame, parallel = said.lens?.model === "parallel";
    const at = origin.map((x) => x / 1000), forward = axes[2], up = axes[1].map((x) => -x);
    const ortho = parallel ? said.size[1] / 2 / said.lens.numbers[0] / 1000 : null;
    v.set({ camera: { at, forward, up, ortho, flat: false, photo: null } });
    // (Once the view has drawn from there: two frames, or a moment where the page draws none, hidden.)
    await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 150); });
  }
  const c = cameraOf(v);
  if (!c) return setInfo(v.key, "The view draws nothing yet: an outline is drawn over what it shows");
  const cam = v.camera();
  // (Canvas to picture and back: through a photo, its pan and zoom; else the canvas is the picture: of one drawn from where
  // the view was, its picture scaled to the canvas as it is now, by the two lenses.)
  const through = cam.through;
  const [n0, n1] = [said && typeof said.frame !== "string" ? said.lens.numbers : null, c.camera.lens?.numbers];
  const toPicture = n0 ? (p) => [n0[1] + ((p[0] - n1[1]) / n1[0]) * n0[0], n0[2] + ((p[1] - n1[2]) / n1[0]) * n0[0]] : (p) => c.pixel(p[0], p[1]);
  const toCanvas = n0 ? (q) => [n1[1] + ((q[0] - n0[1]) / n0[0]) * n1[0], n1[2] + ((q[1] - n0[2]) / n0[0]) * n1[0]] : (q) => (through ? [(q[0] - through.pan[0]) * through.k + cam.w / 2, (q[1] - through.pan[1]) * through.k + cam.h / 2] : q);
  const host = v.canvas.parentElement;
  const svg = document.createElementNS(NS, "svg");
  svg.classList.add("outline-editor");
  Object.assign(svg.style, { position: "absolute", left: `${v.canvas.offsetLeft}px`, top: `${v.canvas.offsetTop}px`, width: `${cam.w}px`, height: `${cam.h}px`, cursor: "crosshair", zIndex: 5, touchAction: "none" });
  host.appendChild(svg);
  const bar = document.createElement("div");
  bar.className = "outline-bar";
  v.lowLeft.append(bar);
  // Its loops as being drawn: each `{ pts: [[x, y]…] (canvas), bends: [null | { mid: [x, y] }…] (run k from pts[k]), closed }`.
  const loops = of ? loopsOf(of.where, toCanvas) : [];
  editing = { v, svg, bar, loops, camera: said ?? c.camera, toPicture, of, undo: [], drag: null, free: null, hover: null };
  const keyOf = (e) => onKey(e);
  editing.keyOf = keyOf;
  document.addEventListener("keydown", keyOf, true);
  bindPointer(svg);
  draw();
}

/** Lets the outline go. */
export function stopOutline() {
  if (!editing) return;
  editing.svg.remove();
  editing.bar.remove();
  document.removeEventListener("keydown", editing.keyOf, true);
  editing = null;
}

// ----- the outline: its runs, as a selection says them -----------------------------------------------------------------

/** Of an outline said (picture pixels), its loops as the editor has them (canvas). */
function loopsOf(where, toCanvas) {
  return where.outline.loops.map((l) => {
    const pts = [toCanvas(l.from)], bends = [];
    for (const r of l.runs) {
      const to = toCanvas(r.to);
      if (r.centre) {
        // (An arc: kept by a point at its middle, which is what is dragged.)
        bends.push({ mid: arcMid(pts[pts.length - 1], to, toCanvas(r.centre), r.ccw) });
      } else bends.push(null);
      pts.push(to);
    }
    // (Its last run back to its start: said, or not.)
    if (pts.length > 1 && near(pts[0], pts[pts.length - 1], 0.01)) pts.pop();
    else bends.push(null);
    return { pts, bends: bends.slice(0, pts.length), closed: true };
  });
}

/** The loops as a selection's outline says them: picture pixels, each run straight or an arc. */
function said() {
  const P = editing.toPicture;
  return {
    loops: editing.loops.filter((l) => l.closed && l.pts.length >= 3).map((l) => {
      const runs = l.pts.map((_, k) => {
        const a = l.pts[k], b = l.pts[(k + 1) % l.pts.length], bend = l.bends[k];
        const arc = bend && circle(a, bend.mid, b);
        return arc ? { to: P(b), centre: P(arc.c), ccw: arc.ccw } : { to: P(b) };
      });
      return { from: P(l.pts[0]), runs };
    }),
  };
}

const near = (a, b, d) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= d;
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** The circle through three points: its middle, and whether a → m → b goes anticlockwise as the picture is seen (y
 *  down). None: they are in a line. */
function circle(a, m, b) {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-6) return null;
  const s = (p) => p[0] * p[0] + p[1] * p[1];
  const c = [(s(a) * (m[1] - b[1]) + s(m) * (b[1] - a[1]) + s(b) * (a[1] - m[1])) / d, (s(a) * (b[0] - m[0]) + s(m) * (a[0] - b[0]) + s(b) * (m[0] - a[0])) / d];
  // (y down, angles from atan2 rise clockwise as seen: from a past m to b with the angle falling, if m is to the left of the
  // way from a to b as seen, is anticlockwise.)
  const cross = (m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0]);
  return { c, ccw: cross < 0 };
}

/** The middle of an arc from a to b about c. */
function arcMid(a, b, c, ccw) {
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  if (ccw) while (a1 >= a0) a1 -= 2 * Math.PI;
  else while (a1 <= a0) a1 += 2 * Math.PI;
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]), t = (a0 + a1) / 2;
  return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
}

/** Points along a run, to draw it by. */
function along(a, b, bend) {
  const arc = bend && circle(a, bend.mid, b);
  if (!arc) return [a, b];
  const { c, ccw } = arc, r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  if (ccw) while (a1 >= a0) a1 -= 2 * Math.PI;
  else while (a1 <= a0) a1 += 2 * Math.PI;
  return Array.from({ length: 33 }, (_, k) => { const t = a0 + ((a1 - a0) * k) / 32; return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]; });
}

/** Points fewer, within `tol` of where they were (Douglas–Peucker): a freehand stroke as straight runs. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / len;
    if (d > worst) [worst, at] = [d, i];
  }
  if (worst <= tol) return [a, b];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

// ----- drawing it ---------------------------------------------------------------------------------------------------------

function draw() {
  const { svg, loops, free, hover } = editing;
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  let d = "", handles = "";
  for (const [li, l] of loops.entries()) {
    const n = l.pts.length, runs = l.closed ? n : n - 1;
    for (let k = 0; k < runs; k++) d += path(along(l.pts[k], l.pts[(k + 1) % n], l.bends[k]));
    for (const [k, p] of l.pts.entries()) handles += `<circle data-loop="${li}" data-corner="${k}" cx="${p[0]}" cy="${p[1]}" r="${hover?.loop === li && hover?.corner === k ? 6 : 4.5}" fill="${k === 0 && !l.closed ? "#ffd400" : "#fff"}" stroke="#d01090" stroke-width="1.5"/>`;
    for (let k = 0; k < runs; k++) {
      const m = l.bends[k]?.mid ?? mid(l.pts[k], l.pts[(k + 1) % n]);
      handles += `<rect data-loop="${li}" data-run="${k}" x="${m[0] - 3}" y="${m[1] - 3}" width="6" height="6" fill="${l.bends[k] ? "#d01090" : "#fff"}" stroke="#d01090" stroke-width="1"/>`;
    }
  }
  if (free) d += path(free);
  const fill = loops.filter((l) => l.closed && l.pts.length >= 3).map((l) => path(l.pts.flatMap((a, k) => along(a, l.pts[(k + 1) % l.pts.length], l.bends[k]).slice(0, -1))) + "Z").join("");
  svg.innerHTML = `<path d="${fill}" fill="rgba(208,16,144,0.12)" fill-rule="evenodd" stroke="none"/><path d="${d}" fill="none" stroke="#d01090" stroke-width="1.6"/>${handles}`;
  const done = loops.some((l) => l.closed && l.pts.length >= 3);
  const chosen = sel.selection && !editing.of ? sel.selection : null;
  const b = (a, label, title, on = true) => `<button data-o="${a}" ${on ? "" : "disabled"} title="${esc(title)}">${esc(label)}</button>`;
  editing.bar.innerHTML = editing.of
    ? `${b("again", `Keep ${editing.of.id}`, "Say the selection again with this outline, in its place", done)}${b("cancel", "Cancel", "Leave it as it was (Escape)")}`
    : `${b("new", "Keep as a selection", "The points the view sees inside the outline, kept as a selection said (Enter)", done)}${chosen ? `${b("any", `Add to ${chosen}`, `${chosen} and these`, done)}${b("less", `Take from ${chosen}`, `${chosen} less these`, done)}${b("all", `Within ${chosen}`, `What is in both: ${chosen} seen through this outline too`, done)}` : ""}${b("cancel", "Cancel", "Let the outline go (Escape)")}`;
  for (const btn of editing.bar.querySelectorAll("button[data-o]")) btn.onclick = () => keep(btn.dataset.o);
}

// ----- what a pointer and the keys do ----------------------------------------------------------------------------------------

function step() {
  editing.undo.push(JSON.stringify(editing.loops));
  if (editing.undo.length > 100) editing.undo.shift();
}

function bindPointer(svg) {
  const at = (e) => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const hit = (e) => {
    const t = e.target;
    if (t.dataset?.corner != null) return { loop: +t.dataset.loop, corner: +t.dataset.corner };
    if (t.dataset?.run != null) return { loop: +t.dataset.loop, run: +t.dataset.run };
    return null;
  };
  svg.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    svg.setPointerCapture(e.pointerId);
    const p = at(e), h = hit(e), open = editing.loops.find((l) => !l.closed);
    // On the first corner of the loop being drawn: it is closed.
    if (h?.corner === 0 && open && editing.loops[h.loop] === open && open.pts.length >= 3) {
      step();
      open.closed = true;
      open.bends.push(null);
      return draw();
    }
    if (h) {
      step();
      editing.drag = { ...h, from: p, moved: false, alt: e.altKey };
      return;
    }
    // Elsewhere: a corner of the loop being drawn, or the start of a freehand stroke. With a loop closed and none being
    // drawn, only with shift: another loop (inside one, a hole); a plain click there does nothing (Cancel, or Escape,
    // begins again).
    if (!open && editing.loops.some((l) => l.closed) && !e.shiftKey) return;
    step();
    editing.free = [p];
    editing.drag = { press: p, moved: false };
  });
  svg.addEventListener("pointermove", (e) => {
    const p = at(e), d = editing.drag;
    if (!d) {
      const h = hit(e);
      if (JSON.stringify(h) !== JSON.stringify(editing.hover)) { editing.hover = h?.corner != null ? h : null; draw(); }
      return;
    }
    if (d.press) {
      if (!d.moved && !near(p, d.press, 4)) d.moved = true;
      if (d.moved) { editing.free.push(p); draw(); }
      return;
    }
    d.moved = true;
    const l = editing.loops[d.loop];
    if (d.corner != null) l.pts[d.corner] = p;
    else if (d.run != null) l.bends[d.run] = d.alt ? null : { mid: p };
    draw();
  });
  svg.addEventListener("pointerup", (e) => {
    const d = editing.drag;
    editing.drag = null;
    if (!d?.press) return draw();
    const p = at(e);
    let open = editing.loops.find((l) => !l.closed);
    if (d.moved) {
      // A freehand stroke: its points, fewer, as corners of the loop being drawn (closed where it ends near its start).
      editing.free.push(p);
      const pts = simplify(editing.free, 1.5);
      if (!open) editing.loops.push((open = { pts: [], bends: [], closed: false }));
      for (const q of open.pts.length ? pts.slice(1) : pts) { open.pts.push(q); open.bends.push(null); }
      open.bends.length = open.pts.length - 1;
      if (open.pts.length >= 3 && near(open.pts[0], open.pts[open.pts.length - 1], 16)) { open.pts.pop(); open.bends.length = open.pts.length - 1; open.closed = true; open.bends.push(null); }
    } else {
      if (!open) editing.loops.push((open = { pts: [], bends: [], closed: false }));
      if (open.pts.length) open.bends.push(null);
      open.pts.push(p);
    }
    editing.free = null;
    draw();
  });
  svg.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const h = hit(e), open = editing.loops.find((l) => !l.closed);
    // On a run: a corner put on it. Elsewhere, of the loop being drawn: it is closed (the click before the double one put
    // a corner of its own, taken away again).
    if (h?.run != null) {
      step();
      const l = editing.loops[h.loop], k = h.run, a = l.pts[k], b = l.pts[(k + 1) % l.pts.length];
      l.pts.splice(k + 1, 0, l.bends[k]?.mid ?? mid(a, b));
      l.bends.splice(k, 1, null, null);
      return draw();
    }
    if (open && open.pts.length >= 4) {
      open.pts.pop();
      open.bends.length = open.pts.length - 1;
      open.closed = true;
      open.bends.push(null);
      draw();
    }
  });
  // (The view is held still while its outline is drawn: what it is drawn over is its picture as it was.)
  svg.addEventListener("wheel", (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
}

function onKey(e) {
  if (!editing || e.target?.closest?.("input, textarea, [contenteditable]")) return;
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === "Escape") { handled(); return stopOutline(); }
  if (e.key === "Enter") {
    handled();
    const open = editing.loops.find((l) => !l.closed);
    if (open && open.pts.length >= 3) { step(); open.closed = true; open.bends.push(null); return draw(); }
    return keep(editing.of ? "again" : "new");
  }
  if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)) {
    handled();
    const was = editing.undo.pop();
    if (was) { editing.loops = JSON.parse(was); draw(); }
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && editing.hover?.corner != null) {
    handled();
    step();
    const l = editing.loops[editing.hover.loop], k = editing.hover.corner;
    l.pts.splice(k, 1);
    l.bends.splice(k, 1);
    if (l.pts.length < (l.closed ? 3 : 1)) editing.loops.splice(editing.hover.loop, 1);
    editing.hover = null;
    draw();
  }
}

// ----- keeping it ---------------------------------------------------------------------------------------------------------

async function keep(how) {
  if (how === "cancel") return stopOutline();
  const outline = said();
  if (!outline.loops.length) return;
  const { v, camera, of } = editing;
  const mine = { outline, in: camera };
  let args;
  if (how === "again") {
    args = { action: "said", id: of.id, selection: { of: "points", where: of.replace(mine) }, root: of.root ?? "" };
  } else if (how === "new") {
    args = { action: "said", ...madeIn(), selection: { of: "points", where: mine }, root: "" };
  } else {
    // (Of the selection chosen: as it is said, with this; one kept before selections were said, by its id's points.)
    const s = st.selections.find((x) => x.id === sel.selection);
    const theirs = s?.how === "said" ? s.selection.where : { list: [] };
    if (s?.how !== "said") return setInfo(v.key, `${sel.selection} was kept before selections were said: say it first (selections migrate)`);
    const where = how === "any" ? { union: [theirs, mine] } : how === "less" ? { difference: [theirs, mine] } : { intersection: [theirs, mine] };
    args = { action: "said", id: s.id, selection: { of: "points", where }, root: s.root ?? "" };
  }
  const r = await workspace.call("selections", args);
  if (r.error) return setInfo(v.key, r.error);
  stopOutline();
  const made = r.text.match(/(?:selected|said again) (\S+)/)?.[1];
  if (made) showSelection(made);
}

/** Of a selection kept, its outline to edit over a view, where it has one: the outline (of `where`, or of the first of
 *  a union, an intersection or a difference), and how to put it back. None: it has none, or not one of this view's camera to edit in. */
export function outlineOf(s) {
  if (s?.how !== "said") return null;
  const w = s.selection?.where;
  if (w?.outline) return { id: s.id, root: s.root, where: w, replace: (mine) => mine };
  for (const k of ["intersection", "union", "difference"]) {
    const i = w?.[k]?.findIndex((x) => x.outline);
    if (i >= 0) return { id: s.id, root: s.root, where: w[k][i], replace: (mine) => ({ [k]: w[k].map((x, j) => (j === i ? mine : x)) }) };
  }
  return null;
}
