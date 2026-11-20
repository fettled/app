// Points said to be on a face of the model: as a photo's sightings place its camera, so a point cloud's points place a
// part (a wheel, where it is turned and how far over: its camber and toe). A selection's points are said to be on a face
// of a body: from the selection's menu, then a click on the face, in any 3D view (the view picks faces till then). The
// workspace keeps it (`point_reading`, as an agent says one) in a file beside the model (`NAME.pointreadings.gen.ts`), each a
// reading: the part (by its address) and its face (by its name), a sample of the selection's points as they were taken
// (mm, in the frame of the point cloud they are of: the selection may change after, the reading does not), and how near
// the face they are read to be. The model says them (`import { pointReadings } from "./NAME.pointreadings.gen"` and
// `says: { ...readPoints(pointReadings) }`), and is built again with them: whatever of where the part is, or of its
// size, is free moves to meet them. Here they are listed, drawn, and left out of the fit or fitted to again.

import { model, project, storage } from "../project.js";
import { msg } from "../shell/panel.js";
import { esc } from "../ui.js";
import { vis } from "../objects.js";
import { workspace } from "../workspace.js";
import { sel, st, views } from "./state.js";
import { renderTools } from "./views.js";
import { kind } from "./kinds.js";
import { renderTree } from "./tree.js";
import { rebuildMarks } from "./marks.js";
import { paramsNow } from "./exact.js";

/** How near its face a reading's points are read to be (mm), unless said: a lidar's noise, and a tyre's own. */
const WITHIN = 5;

const sidecar = () => model.state.file.replace(/\.ts$/, ".pointreadings.gen.ts");
/** The file's entries, each its line and number (the number its comment starts with). */
const entries = (src) => (src ?? "").split("\n").filter((l) => /^\s*\{ .*\bname: "/.test(l)).map((line) => ({ n: Number(line.split("// ").pop().split(":")[0]), line })).filter((e) => e.n > 0);

/** One change to the file at a time: each reads it, changes what it read and writes it. */
let turn = Promise.resolve();
const inTurn = (f) => (...a) => (turn = turn.then(() => f(...a), () => f(...a)));

/** The selection whose points are being said to be on a face: the next face picked is that face. */
let pending = null;

/** Its points are said to be on a face: the views pick faces, and the next one picked is it. */
export function sayOnFace(selection) {
  pending = selection;
  for (const v of Object.values(views)) { v.pickKind = "face"; renderTools(v); }
  msg("Click the face of the model these points are on (a 3D view picks faces now). Esc: none.");
}

/** The point cloud a reading's points are of (`{address, origin, axes}`, the model's frame, m), where the model says it. */
const cloudOf = (address) => st?.clouds?.find((s) => s.address === address && s.origin) ?? null;
/** A point of a point cloud's own frame (mm) in the model's (m). */
const outOfCloud = (s, q) => [0, 1, 2].map((k) => s.origin[k] + (q[0] * s.axes[0][k] + q[1] * s.axes[1][k] + q[2] * s.axes[2][k]) / 1000);

/** The points of `selection` are on `face` of the part at `address`: said as an agent says it (`point_reading`: kept in the
 *  frame of the point cloud they are of), and the model built again with them. */
const say = inTurn(async (selection, address, face) => {
  const r = await workspace.call("point_reading", { selection, part: address, face, within: WITHIN });
  if (r.error) return msg(r.error, true);
  await project.touched();
  await loadReadings();
  msg(r.text);
});

// The face picked, where points are waiting for one: that is it.
document.addEventListener("fettled:chosen", (e) => {
  if (!pending) return;
  const { kind, value } = e.detail ?? {};
  if (kind !== "bodypart" || value?.what !== "face") return;
  const selection = pending;
  pending = null;
  say(selection, value.address, value.name || `#${value.index}`);
});
document.addEventListener("keydown", (e) => {
  if (pending && e.key === "Escape") { pending = null; msg("No face: nothing is said of those points."); }
});

// ----- the readings, as the model has them: listed, drawn, and left out of the fit or fitted to again --------------------

/** The readings of the model's file, each `{ n, name, part, face, within, points, disabled }` (its line's number `n`). */
let readings = [];

/** A line's entry, as data: its object, its keys quoted where they are not (outside its strings). */
function entryOf(line) {
  const body = line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1);
  let out = "", inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) { out += c; if (c === "\\") out += body[++i]; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    const key = /^[A-Za-z_]\w*(?=\s*:)/.exec(body.slice(i));
    if (key && /[{,]\s*$/.test(out)) { out += `"${key[0]}"`; i += key[0].length - 1; continue; }
    out += c;
  }
  return JSON.parse(out);
}

/** The model's readings read again (it was built again, or they were changed here), and what shows them drawn again. */
export async function loadReadings() {
  // (No model open, as on the workspaces page, which is of no place files are kept: none.)
  const src = model.state?.file && storage.store ? await storage.store.read(sidecar()).catch(() => null) : null;
  readings = entries(src).flatMap(({ n, line }) => { try { return [{ n, ...entryOf(line) }]; } catch { return []; } });
  renderTree();
  rebuildMarks();
}

/** How far off a reading's points are, each, as the model now has them (mm, rms; robust): none where it is left out. */
function offOf(r) {
  const g = (paramsNow()?.gave ?? []).find((x) => x.said === r.name);
  if (r.disabled) return null;
  // (Its solve has it in its own deviations, each `within` mm: so many millimetres, then.)
  return g ? (g.off / Math.sqrt(g.values || 1)) * r.within : 0;
}
const findReading = (id) => readings.find((r) => String(r.n) === String(id)) ?? null;
// (Its label alone: its name says the part and face it is on, and its number, which its row says apart.)
const shortName = (r) => { const n = r.name.replace(/ \[\d+\]$/, ""), at = n.lastIndexOf(` on ${r.part}: `); return (at > 0 ? n.slice(0, at) : n).replace(/ \(s\d+\)$/, ""); };
/** Whether the model reads a reading: its script says the file's readings (`readPoints(pointReadings)`), and this one is
 *  among what its solve read. A file kept beside a model that no longer says it is listed, and read by nothing. */
const readBy = (r) => !r.disabled && (paramsNow()?.gave ?? []).some((x) => x.said === r.name);
const offSaid = (r) => (r.disabled ? "left out" : !readBy(r) ? "not read" : `${offOf(r).toFixed(1)} mm`);
const shownReading = (r) => vis("pointreadings", `pointreading:${r.n}`);

/** Readings left out of the fit (`out`), or fitted to again: each its line in the file, `disabled` said or not. */
const leaveOut = inTurn(async (ns, out) => {
  const id = sidecar(), was = await storage.store.read(id);
  if (was == null) return;
  const want = new Set(ns.map(String));
  const text = was.split("\n").map((line) => {
    const e = entries(line)[0];
    if (!e || !want.has(String(e.n))) return line;
    // (Said last in it: `{ name: …, points: […], disabled: true }, // n: who, when`.)
    const plain = line.replace("{ disabled: true, ", "{ ").replace(", disabled: true }", " }");
    const end = plain.lastIndexOf(" }");
    return out && end > 0 ? `${plain.slice(0, end)}, disabled: true${plain.slice(end)}` : plain;
  }).join("\n");
  if (text === was) return;
  await storage.store.write(id, text, { base: was });
  await project.touched();
  await loadReadings();
  msg(`${ns.length === 1 ? "That reading is" : `${ns.length} readings are`} ${out ? "left out of the fit: kept, and not read" : "read again"}: the model is built again.`);
});
const deleteReading = inTurn(async (n) => {
  const id = sidecar(), was = await storage.store.read(id);
  if (was == null) return;
  const text = was.split("\n").filter((line) => String(entries(line)[0]?.n) !== String(n)).join("\n");
  await storage.store.write(id, text, { base: was });
  await project.touched();
  await loadReadings();
});

/** Its colour: chosen, bright; left out, grey; in the fit, by how far off its points are against how near they are read to be. */
const IN = [40, 200, 255], FAR = [255, 170, 40], OUT = [150, 150, 150], ON = [235, 250, 255];
const colourOf = (r, chosen) => (chosen ? ON : r.disabled ? OUT : offOf(r) > 2 * r.within ? FAR : IN);
/** A point of a reading (mm: in its point cloud's frame where it says one, else the model's) where the views draw. */
const atOf = (r) => { const s = r.cloud ? cloudOf(r.cloud) : null; return (p) => (s ? outOfCloud(s, p) : p.map((x) => x / 1000)); };

kind("pointreading", {
  field: "pointreading", group: "pointreadings", order: 41,
  key: (id) => `pointreading:${id}`,
  find: findReading,
  title: (r) => `point reading ${shortName(r)}`,
  rows(row, list) {
    if (!readings.length) return "";
    // (In the fit: those the model's solve read. None of a file its script does not say.)
    const fitted = readings.filter(readBy).length, unsaid = !fitted && readings.some((r) => !r.disabled);
    return list("pointreadings", "Point readings", () => readings.map((r) => row(1, "pointreading", `pointreading:${r.n}`, shortName(r), {
      id: String(r.n), on: String(sel.pointreading) === String(r.n), cls: r.disabled || !readBy(r) ? "muted" : "", note: `${r.face} · ${offSaid(r)}`,
      title: `${r.name}: ${r.points.length} points said to be on ${r.face} of ${r.part}, within ${r.within} mm. ${r.disabled ? "Left out of the fit: kept, and not read." : !readBy(r) ? "Not read: the model's script does not say this file's readings (readPoints(pointReadings)), so nothing is fitted to it." : `In the fit: its points are ${offOf(r).toFixed(1)} mm off their face (rms).`} Right-click to leave it out, or fit to it again`,
    })), { note: unsaid ? "none read by the model" : fitted === readings.length ? `${fitted} in the fit` : `${fitted} of ${readings.length} in the fit`, title: unsaid ? "Points said to be on faces of the model, kept in NAME.pointreadings.gen.ts: but the model's script does not say them (readPoints(pointReadings)), so nothing is fitted to them. Their eyes still draw their points" : "Points said to be on faces of the model (NAME.pointreadings.gen.ts): the model is fitted to them. Their eyes draw their points; right-click to leave them all out of the fit, or fit to them again" });
  },
  groupMenu(add) {
    add("Leave all out of the fit", () => leaveOut(readings.map((r) => r.n), true));
    add("Fit to all", () => leaveOut(readings.map((r) => r.n), false));
  },
  points: (r) => r.points.map(atOf(r)),
  info: (r) => ({
    what: "Point reading", name: shortName(r), id: `[${r.n}]`,
    rows: [["On", `${r.face} of ${r.part}`], ["Of", r.cloud ? `the point cloud ${r.cloud}: its points in its frame, carried wherever it is put` : "the model's frame (no point cloud said: where they were when they were taken)"], ["Points", r.points.length.toLocaleString()], ["Read to within", `${r.within} mm`], ["In the fit", r.disabled ? "no: left out (kept, not read)" : !readBy(r) ? "no: the model's script does not say this file's readings" : "yes"], ...(!readBy(r) ? [] : [["Off its face", `${offOf(r).toFixed(1)} mm rms (robust)`]])],
    note: "Points said to be on a face of the model: whatever is free of where its part is, or its size, moves to meet them. Left out, it is kept and not read.",
  }),
  card: (r) => ({
    label: "Point reading", id: `[${r.n}]`,
    note: offSaid(r),
    body: `${r.points.length} points on ${esc(r.face)} of ${esc(r.part)}, within ${r.within} mm · ${r.disabled ? "left out of the fit" : !readBy(r) ? "not read by the model" : "in the fit"}`,
  }),
  menu(id, m) {
    const r = findReading(id);
    if (!r) return;
    m.add(r.disabled ? "Fit to it again" : "Leave it out of the fit", () => leaveOut([r.n], !r.disabled));
    m.showHide();
    m.divider();
    m.add("Delete it", () => deleteReading(r.n), "danger");
  },
  // Each of its points a small cross: in the fit by how well it fits, left out grey, the one chosen bright.
  marks(out) {
    const d = 0.006;
    for (const r of readings) {
      if (!shownReading(r)) continue;
      const rgb = colourOf(r, String(sel.pointreading) === String(r.n)), at = atOf(r);
      for (const p of r.points) {
        const q = at(p);
        out.line([q[0] - d, q[1], q[2]], [q[0] + d, q[1], q[2]], rgb);
        out.line([q[0], q[1] - d, q[2]], [q[0], q[1] + d, q[2]], rgb);
        out.line([q[0], q[1], q[2] - d], [q[0], q[1], q[2] + d], rgb);
      }
    }
  },
  near(test) {
    for (const r of readings) if (shownReading(r)) for (const p of r.points.map(atOf(r))) { const q = p; test.line(String(r.n), [q[0] - 0.006, q[1], q[2]], [q[0] + 0.006, q[1], q[2]]); }
  },
});
