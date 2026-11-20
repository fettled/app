// How a lidar's ranges fit the model (`ranged(part, session, faces)` in its script: the rays that first meet the faces
// said, read by their ranges to them, found again as the model is). The engine says each reading ray by ray (`ranged`:
// fettled_script::part::ranged_json): where the ray ended, where it meets its face, how far off it is in its own
// deviations, and how much it counts under its loss. Here they are listed (each part ranged, and each of its faces: how
// many rays, what share fit, how far off those are), drawn (each ray as its range error: a line from where it ended to
// where it meets its face, coloured by how far off that is in its deviations: short of its face one way, beyond it the
// other; faint as it counts for little, and where it counts for next to nothing drawn only of what is chosen), and told
// of in Details, with how its rays are spread.
//
// How far off is said two ways, as the reader chooses (Details: σ or mm; kept): in millimetres along the ray, as it is
// in the scene; or in σ, each ray's own standard deviation of range, which is what the fit reads it in (so that a ray
// met aslant, or from far off, whose range is worth less, counts for less). σ is the script's to say: the session's
// lidar's noise and `ranged`'s `surface`.

import { model } from "../project.js";
import { vis } from "../objects.js";
import { store, stored } from "../ui.js";
import { sel, views } from "./state.js";
import { kind } from "./kinds.js";
import { renderTree } from "./tree.js";
import { rebuildMarks } from "./marks.js";
import { describeObject } from "./object.js";
import { renderChips } from "./chosen.js";

/** The readings, as the engine says them, each with how far off each ray is in millimetres too (`mm`: along it, from
 *  its face to where it ended; less than none, short of the face) and what is worked out of its rays once (`sum`). */
let fits = [];
/** How far off is said: "sigma" (in each ray's own deviations) or "mm". Kept. */
const UNIT = "fettled.ranged.unit";
let unit = stored(UNIT, "sigma") === "mm" ? "mm" : "sigma";

/** A reading's rays' range errors in millimetres: how far along each from where it meets its face to where it ended,
 *  signed as its `off` is. */
function millimetres(r) {
  const out = new Float32Array(r.off.length);
  for (let k = 0; k < out.length; k++) out[k] = Math.sign(r.off[k]) * 1000 * Math.hypot(r.ended[3 * k] - r.meets[3 * k], r.ended[3 * k + 1] - r.meets[3 * k + 1], r.ended[3 * k + 2] - r.meets[3 * k + 2]);
  return out;
}

/** What is said of readings' rays together: how many, how many count for half or more (they fit: the rest ended on
 *  something else, and are let go of, or nearly), and of those that fit how far off they are (rms, and their mean, which
 *  way: a face that is not where the model has it), and of all; each in deviations (`s`) and in millimetres (`mm`). And
 *  what a deviation is, of these rays, in millimetres: the middle one's, and the tenth and ninetieth of a hundred's
 *  (each ray has its own; from those far enough off to tell it by). */
function summed(readings) {
  let n = 0, core = 0;
  const sq = { s: 0, mm: 0 }, coreSq = { s: 0, mm: 0 }, coreSum = { s: 0, mm: 0 }, sigmas = [];
  for (const r of readings) for (let k = 0; k < r.off.length; k++) {
    const e = r.off[k], d = r.mm[k];
    n++;
    sq.s += e * e; sq.mm += d * d;
    if (r.weight[k] >= 0.5) { core++; coreSq.s += e * e; coreSq.mm += d * d; coreSum.s += e; coreSum.mm += d; }
    if (Math.abs(e) >= 0.2 && Math.abs(d) >= 0.5) sigmas.push(Math.abs(d / e));
  }
  sigmas.sort((a, b) => a - b);
  const at = (q) => (sigmas.length ? sigmas[Math.min(sigmas.length - 1, Math.floor(q * sigmas.length))] : null);
  const both = (f) => ({ s: f("s"), mm: f("mm") });
  return { n, core, share: n ? core / n : 0, rms: both((u) => (n ? Math.sqrt(sq[u] / n) : 0)), coreRms: both((u) => (core ? Math.sqrt(coreSq[u] / core) : 0)), coreMean: both((u) => (core ? coreSum[u] / core : 0)), sigma: { mid: at(0.5), lo: at(0.1), hi: at(0.9) } };
}

/** The model's ranges read again (it was built again), and what shows them drawn again. */
export async function loadRanged() {
  const got = model.built ? await model.ask("ranged").catch(() => []) : [];
  fits = (Array.isArray(got) ? got : []).map((r) => { const x = { ...r, id: `${r.part}:${r.face}`, mm: millimetres(r) }; x.sum = summed([x]); return x; });
  drawn = null;
  sums.clear();
  renderTree();
  rebuildMarks();
}

/** The parts ranged, each with its faces' readings. */
const parts = () => [...new Set(fits.map((r) => r.part))].map((part) => ({ id: part, part, readings: fits.filter((r) => r.part === part) }));
/** One of them by its id: a part ranged (its address), or one face's reading (`PART:face`). */
const find = (id) => {
  const r = fits.find((x) => x.id === id);
  if (r) return { id, part: r.part, face: r.face, readings: [r] };
  return parts().find((p) => p.id === id) ?? null;
};
/** What is said of all the rays of one of them (worked out once, of a part's or of them all: "" them all). */
const sums = new Map();
const sumOf = (it) => {
  if (it.readings.length === 1) return it.readings[0].sum;
  if (!sums.has(it.id)) sums.set(it.id, summed(it.readings));
  return sums.get(it.id);
};
const keyOf = (id) => `ranged:${id}`;
/** Whether a reading's rays are drawn: its eye is on, its part's, and the group's. */
const shown = (r) => vis("ranged", keyOf(r.part), keyOf(r.id));
/** How far off, as it is said now: a figure of both (`{ s, mm }`), to so many places. */
const off = (v, places = 2) => (unit === "mm" ? `${v.mm.toFixed(1)} mm` : `${v.s.toFixed(places)}σ`);
const said = (s) => `${s.n.toLocaleString()} rays · ${(100 * s.share).toFixed(0)}% fit · ${off(s.coreRms, 1)}`;
/** The loss a reading is read by (the script's, of `losses`), in words. */
const lossSaid = (l) => ({
  cauchy: `Cauchy's, of ${l?.scale}σ: what is far off pulls less and less, and never nothing`,
  huber: `Huber's, of ${l?.scale}σ: beyond that, a pull that grows no more`,
  tukey: `Tukey's, of ${l?.scale}σ: beyond that, no pull at all (left out)`,
}[l?.loss] ?? "none (least squares): every ray counts whole");
/** What σ is, of these rays: said where they are told of. */
const sigmaSaid = (s) => `A ray's own standard deviation of range: how far its range may be off by chance. It is worked out for each ray from what the script says (the lidar's range noise; its ray's direction, which matters where it meets the face aslant; and how far the real surface may be from the model's face), so a ray met aslant or from far off has a larger one. The fit reads every ray in its own σ.${s.sigma.mid ? ` Of these rays, 1σ is ${s.sigma.mid.toFixed(1)} mm at the middle one (${s.sigma.lo.toFixed(1)} to ${s.sigma.hi.toFixed(1)} mm for most).` : ""}`;
const TITLE = "rays that first meet it, read by their ranges to it. Fit: those that count for half or more under its loss; the rest ended on something else, and are let go of, or nearly. Then how far off those that fit are (rms): in σ (each ray's own standard deviation of range: about one where the noise said is the noise there is) or in mm along the ray, as Details is set";

// How far off a ray is, as a colour: on its face, pale; short of it, toward blue; beyond it, toward red: full at three
// of its deviations. Faint as it counts for little.
const ON = [236, 236, 228], SHORT = [40, 120, 255], BEYOND = [255, 70, 40];
function colourOf(e, weight) {
  const t = Math.min(1, Math.abs(e) / 3), to = e < 0 ? SHORT : BEYOND;
  return [ON[0] + (to[0] - ON[0]) * t, ON[1] + (to[1] - ON[1]) * t, ON[2] + (to[2] - ON[2]) * t, 50 + 205 * Math.sqrt(weight)];
}

/** How much a ray must count to be drawn where what it is of is not chosen: one that counts for less is of something else
 *  (what is in front, what is behind), its line as long as that is far, and is drawn with what is chosen only. */
const COUNTS = 0.01;

/** What is drawn over the views, as it was last made (by what it is of): each ray's range error, a line from where it
 *  ended (its range as measured) to where it meets its face along it (its range as the model has it). Its length is
 *  how far off its range is; one on its face is a speck on the face. */
let drawn = null;
function draw() {
  const chosen = sel.ranged ? find(sel.ranged) : null, whole = new Set(chosen?.readings.map((r) => r.id) ?? []);
  const show = fits.filter(shown), of = JSON.stringify([show.map((r) => r.id), [...whole]]);
  if (drawn?.of !== of) {
    const pos = [], col = [];
    for (const r of show) {
      const all = whole.has(r.id);
      for (let k = 0; k < r.off.length; k++) {
        if (!all && r.weight[k] < COUNTS) continue;
        const p = [r.ended[3 * k], r.ended[3 * k + 1], r.ended[3 * k + 2]], q = [r.meets[3 * k], r.meets[3 * k + 1], r.meets[3 * k + 2]];
        // (From the face to where it ended; one that ended on the face, or within a few millimetres, drawn 4 mm long from the
        // face the way it lies, so that it is seen: a speck.)
        const d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]], l = Math.hypot(...d);
        const e = l >= 0.004 ? p : l > 1e-6 ? [q[0] + (0.004 * d[0]) / l, q[1] + (0.004 * d[1]) / l, q[2] + (0.004 * d[2]) / l] : [q[0], q[1], q[2] + 0.004];
        const c = colourOf(r.off[k], r.weight[k]);
        pos.push(...q, ...e);
        col.push(...c, ...c);
      }
    }
    drawn = { of, lines: { pos: new Float32Array(pos), col: new Uint8Array(col), width: 2 } };
  }
  for (const v of Object.values(views)) v.setOver("ranged", drawn.lines);
}

/** A round figure near `x`: of 1, 2, 2.5 and 5, by tens. */
function round(x) {
  const p = 10 ** Math.floor(Math.log10(x)), m = x / p;
  return p * [1, 2, 2.5, 5, 10].reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
}

/** How its rays are spread, in Details: how many in each bar from so far short of the face to so far beyond (what is
 *  further, at the ends), in three shades by how much each counts under its loss (half or more: it fits; less, and still
 *  pulling; nothing: left out, as Tukey's leaves out what is beyond its scale), with its loss's scale marked either
 *  side; and over them a normal's, of as many as fit: what they would be were the noise said the noise there is. In σ,
 *  a bar is half of one, from six short to six beyond, and the normal is a unit one. In mm, a bar is about half the
 *  middle ray's σ, and the loss's scale and the normal are as that ray has them: each ray's own differs. */
function histogram(it) {
  const s = sumOf(it), mm = unit === "mm" && s.sigma.mid, N = 24, W = 300, H = 110, PAD = 14;
  // (What a bar is wide, and one deviation, in what is drawn: millimetres, or deviations.)
  const STEP = mm ? round(0.5 * s.sigma.mid) : 0.5, SIGMA = mm ? s.sigma.mid : 1, LO = (-N / 2) * STEP, u = mm ? " mm" : "σ";
  const FIT = "#4a7bd0", SOME = "#a9c1ec", OUT = "#c9cdd6";
  const fit = new Array(N + 2).fill(0), some = new Array(N + 2).fill(0), out = new Array(N + 2).fill(0);
  let core = 0;
  for (const r of it.readings) for (let k = 0; k < r.off.length; k++) {
    const b = Math.max(0, Math.min(N + 1, 1 + Math.floor(((mm ? r.mm[k] : r.off[k]) - LO) / STEP))), w = r.weight[k];
    if (w >= 0.5) { fit[b]++; core++; } else if (w > 0) some[b]++; else out[b]++;
  }
  const normal = (x) => (core * STEP * Math.exp(-0.5 * (x / SIGMA) ** 2)) / (SIGMA * Math.sqrt(2 * Math.PI));
  const top = Math.max(1, ...fit.map((f, b) => f + some[b] + out[b]), normal(0));
  const bw = W / (N + 2), y = (c) => H - (H * c) / top, x = (e) => ((e - LO) / STEP + 1) * bw;
  // (Each bar from the axis up: those that fit, then those that still pull, then those left out.)
  const bar = (b, from, n, fill) => (n ? `<rect x="${(b * bw + 0.5).toFixed(1)}" y="${y(from + n).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${(y(from) - y(from + n)).toFixed(1)}" fill="${fill}"/>` : "");
  const bars = fit.map((f, b) => bar(b, 0, f, FIT) + bar(b, f, some[b], SOME) + bar(b, f + some[b], out[b], OUT)).join("");
  const curve = Array.from({ length: 97 }, (_, k) => { const e = LO + (k * (N * STEP)) / 96; return `${x(e).toFixed(1)},${y(normal(e)).toFixed(1)}`; }).join(" ");
  const ticks = [-N / 2, -N / 4, 0, N / 4, N / 2].map((k) => `<text x="${x(k * STEP).toFixed(1)}" y="${H + 11}" text-anchor="middle">${+(k * STEP).toFixed(2)}${u}</text>`).join("");
  // (Its loss's scale, either side, where it is one loss's and within what is drawn.)
  const loss = it.readings[0].loss, one = it.readings.every((r) => r.loss?.loss === loss?.loss && r.loss?.scale === loss?.scale), c = one && loss?.scale * SIGMA < -LO ? loss.scale * SIGMA : null;
  const scale = c ? [-c, c].map((e) => `<line x1="${x(e).toFixed(1)}" y1="0" x2="${x(e).toFixed(1)}" y2="${H}" stroke="#555" stroke-width="0.8" stroke-dasharray="3 2"/>`).join("") : "";
  const gate = { tukey: "beyond it no ray pulls", huber: "beyond it a ray's pull grows no more", cauchy: "at it a ray's pull is greatest, and falls away beyond" }[loss?.loss];
  const key = (fill, text) => `<span style="display:inline-block;width:8px;height:8px;background:${fill};margin:0 3px 0 6px"></span>${text}`;
  const el = document.createElement("div");
  el.style.marginTop = "10px";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H + PAD}" width="100%" style="max-width:${W + 40}px;font:9px sans-serif;fill:var(--muted)" role="img" aria-label="How far off its rays are">${bars}${scale}<polyline points="${curve}" fill="none" stroke="#d2691e" stroke-width="1.2"/><line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="currentColor" stroke-width="0.5"/>${ticks}</svg><div class="muted" style="font-size:11px">How far each ray ended from its face, ${mm ? "in millimetres along it" : "in its own σ"}: short of it to the left, beyond it to the right (what is further than the last mark, at the ends). By how much each counts under its loss:${key(FIT, "half or more (it fits)")}${key(SOME, "less, and still pulling")}${key(OUT, "nothing: left out")}.${c && gate ? ` Dashed: the loss's scale, ±${loss.scale}σ${mm ? ` (about ±${c.toFixed(1)} mm: of the middle ray's σ; each ray's own differs)` : ""}: ${gate}.` : ""} The curve: a normal's of ${mm ? `the middle ray's σ (${SIGMA.toFixed(1)} mm)` : "one σ"}, of as many as fit: what they would be were the noise said the noise there is.</div>`;
  return el;
}

/** In Details, how far off is said: in σ or in mm, chosen there and kept; everything that says it says it so from then. */
function units(it) {
  const el = document.createElement("div");
  el.style.marginTop = "8px";
  el.innerHTML = `<span class="muted">How far off, in</span> <label title="Each ray's own standard deviation of range: what the fit reads it in"><input type="radio" name="rangedunit" value="sigma" ${unit === "sigma" ? "checked" : ""}> σ</label> <label title="Millimetres along the ray, from its face to where it ended: as it is in the scene"><input type="radio" name="rangedunit" value="mm" ${unit === "mm" ? "checked" : ""}> mm</label>`;
  for (const i of el.querySelectorAll("input")) i.onchange = () => {
    unit = i.value;
    store(UNIT, unit);
    renderTree();
    renderChips();
    describeObject("ranged", it, it.id);
  };
  return el;
}

kind("ranged", {
  field: "ranged", group: "ranged", order: 42,
  key: keyOf,
  find,
  title: (it) => `the lidar's ranges to ${it.id}`,
  rows(row, list) {
    if (!fits.length) return "";
    const all = sumOf({ id: "", readings: fits });
    return list("ranged", "Lidar ranges", () => parts().flatMap((p) => [
      row(1, "ranged", keyOf(p.id), p.part, { id: p.id, on: sel.ranged === p.id, note: said(sumOf(p)), title: `${p.part}: the lidar's ${TITLE}. Its eye draws each as its range error: a line from where the ray ended to where it meets the face (short of the face toward blue, beyond it toward red). Chosen, those that count for next to nothing are drawn too` }),
      ...p.readings.map((r) => row(2, "ranged", keyOf(r.id), r.face, { id: r.id, on: sel.ranged === r.id, note: said(r.sum), title: `${r.name}: the ${TITLE}` })),
    ]), { note: said(all), title: "What the model's lidars ranged of it (ranged, in its script): the rays that first meet the faces said, found again as the model is, each read by its range to its face. Their eyes draw them; choose one for all its rays and how they are spread" });
  },
  // (Where its rays ended: a sample of them, for its extent.)
  points: (it) => it.readings.flatMap((r) => { const step = Math.max(1, Math.floor(r.off.length / 200)), out = []; for (let k = 0; k < r.off.length; k += step) if (r.weight[k] >= 0.5) out.push([r.ended[3 * k], r.ended[3 * k + 1], r.ended[3 * k + 2]]); return out; }),
  info: (it) => {
    const s = sumOf(it), rays = it.readings.reduce((n, r) => n + r.rays, 0), mean = unit === "mm" ? s.coreMean.mm : s.coreMean.s, level = unit === "mm" ? 0.05 * (s.sigma.mid ?? 1) : 0.05;
    return {
      what: it.face ? "A lidar's ranges to a face of the model" : "A lidar's ranges to a part of the model", name: it.id, id: it.readings.length === 1 ? it.readings[0].name : `${it.readings.length} faces`,
      rows: [
        ["Rays", `${rays.toLocaleString()} first meet it${rays > s.n ? `; ${(rays - s.n).toLocaleString()} only graze it, and say nothing` : ""}`],
        ["Fit", `${s.core.toLocaleString()} (${(100 * s.share).toFixed(0)}%) count for half or more`],
        ["Off, of those that fit", `${off(s.coreRms)} rms; ${mean >= 0 ? "+" : "−"}${off({ s: Math.abs(s.coreMean.s), mm: Math.abs(s.coreMean.mm) })} on average (${Math.abs(mean) < level ? "neither way" : mean < 0 ? "short of it: what is there is nearer the lidar than the model's face" : "beyond it: what is there is further than the model's face"})`],
        ["Off, of all", `${off(s.rms, 1)} rms`],
        ["Loss", lossSaid(it.readings[0].loss)],
        ["σ", sigmaSaid(s)],
      ],
      note: "Each ray is read by how far it went less how far along it its face is (its range error, the line drawn of it), over its σ. Nothing is picked by hand: the rays are those that first meet the faces said, as the model is found.",
      mount: (box) => box.append(units(it), histogram(it)),
    };
  },
  card: (it) => ({ label: "Lidar ranges", id: it.id, note: said(sumOf(it)), body: `${it.face ? "a face" : `${it.readings.length} faces`}: each ray a line from where it ended to where it meets its face: its range error` }),
  menu(id, m) {
    m.showHide();
  },
  // (Not lines of the marks: drawn over the views, which is told as the marks are made again: what is shown, or chosen,
  // has changed.)
  marks() {
    draw();
  },
});
