// The Params tool (docs/part-core.md, "What is built"): of a part script, each param as it was found; what decides
// it (what must hold, a level, nothing); what the script says of it, and how firmly; what is kept of it in a layer
// over the script (docs/layers.md: yours, a draft, in italics and kept for everyone by ↑; or the model's own), and how
// firmly; and how far it is from what is said of it (red where it gave way). Its level is chosen beside it: as the script says, required (a must), measured, held, dragged, a hint, a
// fallback, free, or any level between; and how near (±) it is weighed against others at its level. A value dragged
// across keeps it there (held, unless another level is chosen), and the model is built again; × lets it go, and what
// the script says of it is where it is again. What is decided by what must hold is shown so, and not moved. What is
// kept of params the script no longer makes is listed, to be let go; and the readings kept. Of another model, nothing.
// The params are grouped by their addresses (each group folded or open, kept so for this viewer), found by what is
// typed (each word somewhere in an address), and those locked (decided by what must hold, or a part held) hidden at a click.

import { $, esc } from "../ui.js";
import { model, showingBefore } from "../project.js";
import { msg } from "./panel.js";
import { addTool } from "./dock.js";
import { exactFor, showSettling } from "../scene/exact.js";
import { views } from "../scene/state.js";
import { renderScratch } from "../scene/scratch.js";

addTool("params", { title: "Params", el: document.querySelector('.pane[data-pane="params"]'), side: "right", beside: "checks" });

/** The levels named, the firmest first, as the select offers them: its value, and its name. */
const STOPS = [["must", "required"], ["80", "measured"], ["70", "held"], ["60", "dragged"], ["40", "hint"], ["20", "fallback"], ["start", "free"]];
/** A tier as the engine has it (`"must"`, `{ at: { level, within } }`, `"start"`), from one as it is said (`{ name,
 *  level, within }`) or a select's value, to within `within` where it is at a level. */
function engineTier(t, within) {
  const v = typeof t === "string" ? t : t.name === "must" ? "must" : t.name === "free" ? "start" : String(t.level);
  return v === "must" || v === "start" ? v : { at: { level: Number(v), within: within ?? t.within ?? 1 } };
}
/** A tier as it is said, in a select's value. */
const selectValue = (t) => (t.name === "must" ? "must" : t.name === "free" ? "start" : String(t.level));

/** How a value is shown, by its kind (`measure`, docs/units.md) in the project's units (`units`): the engine has a
 *  length in millimetres, an angle in degrees, everything else in SI. Its text; how far a pixel of drag moves it (in
 *  the engine's units); what one of the unit it is typed in is, in the engine's; and that unit's name. Of no kind
 *  (a script of before), as a number. */
export function shown(measure, units) {
  const plain = (v) => v.toFixed(Math.abs(v) < 10 ? 3 : 1);
  if (measure === "length" && units === "imperial") return { text: feetInches, step: 25.4 / 16, unit: 25.4, name: "in" };
  if (measure === "length") return { text: (v) => `${v.toFixed(1)} mm`, step: 1, unit: 1, name: "mm" };
  if (measure === "angle") return { text: (v) => `${v.toFixed(2)}°`, step: 0.1, unit: 1, name: "°" };
  if (measure === "ratio") return { text: (v) => v.toFixed(4), step: 0.001, unit: 1, name: "" };
  return { text: plain, step: 0.01, unit: 1, name: "" };
}
/** A length in millimetres as feet and inches, to a sixteenth: `8' 3 5/16"`. */
function feetInches(v) {
  const sign = v < 0 ? "-" : "";
  let sixteenths = Math.round((Math.abs(v) / 25.4) * 16);
  const feet = Math.floor(sixteenths / 192);
  sixteenths -= feet * 192;
  const inches = Math.floor(sixteenths / 16), part = sixteenths % 16;
  const g = (a, b) => (b ? g(b, a % b) : a), d = g(part, 16);
  const frac = part ? ` ${part / d}/${16 / d}` : "";
  return feet ? `${sign}${feet}' ${inches}${frac}"` : `${sign}${inches}${frac}"`;
}

/** What is shown of the params: what is typed to find them (each word somewhere in a param's address), whether those
 *  locked are hidden, whether only those kept or only those off are shown, and which groups (by the address they are
 *  of) are folded. Kept for this viewer across models and reloads. */
const view = (() => {
  const v = { find: "", hideLocked: true, keptOnly: false, offOnly: false, movesOnly: false, folded: new Set() };
  try {
    const s = JSON.parse(localStorage.getItem("fettled.params.view") ?? "null");
    if (s) Object.assign(v, { hideLocked: s.hideLocked ?? true, keptOnly: !!s.keptOnly, offOnly: !!s.offOnly, folded: new Set(s.folded ?? []) });
  } catch {}
  return v;
})();
function saveView() {
  try {
    localStorage.setItem("fettled.params.view", JSON.stringify({ hideLocked: view.hideLocked, keptOnly: view.keptOnly, offOnly: view.offOnly, folded: [...view.folded] }));
  } catch {}
}
/** The params last read, drawn again as what is shown of them changes. */
let last = null;

/** A param decided by what must hold, or held as a part: not a person's to move here. */
const isLocked = (r) => r.by === "must" || r.by === "part held";
/** A param that gave way to firmer things. */
const isOff = (r) => r.off != null && r.off > 1e-6 * Math.max(1, Math.abs(r.value));

/** The toolbar, wired once. */
function wireTools() {
  const find = $("paramsFind");
  if (!find || find.dataset.wired) return;
  find.dataset.wired = "1";
  find.value = view.find;
  find.oninput = () => { view.find = find.value; draw(); };
  find.onkeydown = (e) => { if (e.key === "Escape" && find.value) { find.value = view.find = ""; draw(); e.stopPropagation(); } };
  const toggle = (id, key) => {
    const b = $(id);
    b.setAttribute("aria-pressed", String(view[key]));
    b.onclick = () => { view[key] = !view[key]; b.setAttribute("aria-pressed", String(view[key])); saveView(); draw(); };
  };
  toggle("paramsLocked", "hideLocked");
  toggle("paramsKept", "keptOnly");
  toggle("paramsOff", "offOnly");
  toggle("paramsMoves", "movesOnly");
  $("paramsOpen").onclick = () => { view.folded.clear(); saveView(); draw(); };
  $("paramsShut").onclick = () => { for (const g of groupsOf(last?.params ?? [])) view.folded.add(g); saveView(); draw(); };
}

/** Every group's address (each address a param is under, but its own), of these params. */
function groupsOf(params) {
  const out = new Set();
  for (const r of params) {
    const parts = r.address.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

/** The params as a tree by their addresses: each node its params (directly under it) and its groups. A group with no
 *  params of its own and one group under it is shown as one (`a/b`), so a long chain does not indent. */
function treeOf(params) {
  const root = { path: "", label: "", params: [], groups: new Map() };
  for (const r of params) {
    const parts = r.address.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      if (!node.groups.has(parts[i])) node.groups.set(parts[i], { path, label: parts[i], params: [], groups: new Map() });
      node = node.groups.get(parts[i]);
    }
    node.params.push(r);
  }
  const squash = (n) => {
    for (const [k, g] of n.groups) {
      let h = g;
      while (!h.params.length && h.groups.size === 1) {
        const [only] = h.groups.values();
        h = { ...only, label: `${h.label}/${only.label}` };
      }
      n.groups.set(k, h);
      squash(h);
    }
  };
  squash(root);
  return root;
}

export async function renderParams() {
  const table = $("params");
  if (!table) return;
  wireTools();
  last = model.state && !model.state.error ? await model.ask("params") : null;
  draw();
  renderScratch(last && !last.error ? last : null);
}

// (A param gone to from elsewhere (the card of what is tried out): found here, by its address.)
document.addEventListener("fettled:find-param", (e) => {
  const find = $("paramsFind");
  if (!find) return;
  find.value = view.find = e.detail;
  draw();
  find.closest(".pane")?.scrollIntoView?.({ block: "nearest" });
});

/** The params last read, as what is shown of them says: found, filtered, grouped. */
function draw() {
  const table = $("params"), orphaned = $("paramsOrphaned"), count = $("paramsCount");
  if (!table) return;
  const p = last;
  if (!p || p.error || !Array.isArray(p.params)) {
    table.innerHTML = `<tr><td class="muted">${p?.error ? esc(p.error) : "Not a part script."}</td></tr>`;
    orphaned.textContent = "";
    count.textContent = "";
    $("paramsRead").textContent = "";
    return;
  }
  // (What a person does here is tried out, over their layer: kept from the scratch card. Let go of: wherever it is kept.)
  const keep = async (address, value, tier) => {
    const w = tier === null ? await model.letGo([`param ${address}`]) : await model.params({ [address]: { value, tier } }, { scratch: true });
    if (w.error) msg(w.error, true);
  };
  const words = view.find.toLowerCase().split(/\s+/).filter(Boolean);
  const shownRows = p.params.filter((r) => (!view.hideLocked || !isLocked(r)) && (!view.keptOnly || r.kept) && (!view.offOnly || isOff(r)) && (!view.movesOnly || !moving || moving.params.has(r.address))
    && words.every((w) => r.address.toLowerCase().includes(w)));
  const locked = p.params.filter(isLocked).length;
  $("paramsLocked").textContent = `Hide locked (${locked})`;
  count.textContent = shownRows.length === p.params.length ? `${p.params.length} params` : `${shownRows.length} of ${p.params.length} params shown`;
  table.innerHTML = `<tr><th>Param</th><th class=num>Value</th><th title="What decides it now">By</th><th title="How firmly it is said: as the script says, or kept beside it">Level</th><th class=num title="How near it is weighed against others at its level">±</th><th></th></tr>`;
  if (!shownRows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="muted">${p.params.length ? "No param is shown: none found, or all hidden." : "No params."}</td>`;
    table.appendChild(tr);
  }
  // (While finding, every group with a param found is open: what is found is not folded away.)
  const searching = words.length > 0;
  const mark = (text) => {
    const lower = text.toLowerCase(), hit = new Array(text.length).fill(false);
    for (const w of words) for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) hit.fill(true, i, i + w.length);
    let out = "";
    for (let i = 0; i < text.length;) {
      let j = i;
      while (j < text.length && hit[j] === hit[i]) j++;
      out += hit[i] ? `<mark>${esc(text.slice(i, j))}</mark>` : esc(text.slice(i, j));
      i = j;
    }
    return out;
  };
  const all = (n) => n.params.concat([...n.groups.values()].flatMap(all));
  const walk = (n, depth) => {
    for (const r of n.params) table.appendChild(paramRow(r, p, keep, depth, mark));
    for (const g of n.groups.values()) {
      const rows = all(g), off = rows.filter(isOff).length, folded = !searching && view.folded.has(g.path);
      const tr = document.createElement("tr");
      tr.className = "pgroup";
      tr.innerHTML = `<td colspan="6" style="padding-left:${4 + depth * 12}px" title="${esc(g.path)}"><span class="tw">${folded ? "▸" : "▾"}</span>${mark(g.label)}<span class="n">${rows.length}</span>${off ? `<span class="bad" title="Gave way to firmer things">${off} off</span>` : ""}</td>`;
      tr.onclick = () => {
        if (searching) return;
        if (view.folded.has(g.path)) view.folded.delete(g.path);
        else view.folded.add(g.path);
        saveView();
        draw();
      };
      table.appendChild(tr);
      if (!folded) walk(g, depth + 1);
    }
  };
  walk(treeOf(shownRows), 0);
  // (Everything kept of params, let go at once; everything of yours, kept for everyone.)
  const kept = p.params.filter((r) => r.kept != null).map((r) => r.address).concat(p.orphaned ?? []);
  const yours = p.params.filter((r) => r.kept?.yours).length + (p.drags ?? []).filter((d) => d.yours).length;
  if (kept.length || yours) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6">${yours ? `<button class="mini" data-share title="Keep everything in your layer (params held, drags) for everyone: moved into the model's own generated file">Keep all ${yours} of yours for everyone</button> ` : ""}${kept.length ? `<button class="mini" data-let title="Let go of everything kept of its params in your layer: each is as the script says again">Let go of all ${kept.length} kept</button>` : ""}</td>`;
    tr.querySelector("button[data-let]")?.addEventListener("click", async () => {
      const w = await model.letGo(kept.map((a) => `param ${a}`));
      if (w.error) msg(w.error, true);
    });
    tr.querySelector("button[data-share]")?.addEventListener("click", async () => {
      const w = await model.share(null);
      if (w.error) msg(w.error, true);
    });
    table.appendChild(tr);
  }
  // (Everything that gave way to firmer things, folded: each param's is beside it above; the rest (a drag, a reading
  // of geometry, a layout) only here.)
  const gave = (p.gave ?? []).map((g) => `<div>${esc(g.said)}: ${esc(g.tier)}, off by ${g.off.toFixed(g.off < 10 ? 3 : 1)}${g.within != null ? ` (± ${+g.within.toPrecision(4)})` : ""}</div>`);
  orphaned.innerHTML = (p.orphaned ?? []).map((a) => `<div>${esc(a)} is kept, and is not there. <button class="mini" data-release="${esc(a)}">Let it go</button></div>`).join("")
    + (gave.length ? `<details style="margin-top:4px"><summary class="muted" style="font-size:11px">Everything that gave way to firmer things (${gave.length})</summary>${gave.join("")}</details>` : "");
  for (const b of orphaned.querySelectorAll("button[data-release]")) b.onclick = () => model.letGo([`param ${b.dataset.release}`]);
  renderReadings(p);
}

/** Each param's value shown as `p` has it (a drag settling): all but the one dragged (`but`), whose cell follows the
 *  pointer. */
function showValues(p, but) {
  const table = $("params");
  if (!table || !Array.isArray(p?.params)) return;
  const rows = new Map([...table.querySelectorAll("tr[data-address]")].map((tr) => [tr.dataset.address, tr]));
  for (const r of p.params) {
    const tr = rows.get(r.address);
    if (!tr || r.address === but) continue;
    tr.children[1].textContent = shown(r.measure, p.units).text(r.value);
  }
}

/** A param's row: its name (the last of its address, under its group, `depth` deep), its value (dragged across to
 *  keep it there), what decides it, its level and how near, and what is kept of it to share or let go. */
function paramRow(r, p, keep, depth, mark) {
  const tr = document.createElement("tr");
  const kept = r.kept, as = shown(r.measure, p.units);
  // (Shown as it was before what is tried out: nothing is added to that till it is on again.)
  const before = showingBefore(), fixed = isLocked(r) || before;
  const said = kept?.tier ?? r.own?.tier;
  const off = isOff(r);
  const name = r.address.slice(r.address.lastIndexOf("/") + 1);
  const options = [`<option value="script">${esc(r.own ? `script: ${r.own.tier.name}` : "script: free")}</option>`]
    .concat(STOPS.map(([v, n]) => `<option value="${v}">${n}</option>`))
    .concat(kept && !STOPS.some(([v]) => v === selectValue(kept.tier)) ? [`<option value="${selectValue(kept.tier)}">${esc(kept.tier.name)}</option>`] : [])
    .concat([`<option value="custom">level…</option>`]);
  tr.innerHTML = `<td class="pname" title="${esc(r.address)}" style="padding-left:${4 + depth * 12 + (depth ? 12 : 0)}px;${kept ? "font-weight:600" : ""}${kept?.yours ? ";font-style:italic" : ""}${kept?.scratch ? ";color:var(--accent)" : ""}">${mark(name)}</td>`
    + `<td class="num${fixed ? " muted" : " drag"}" title="${before ? "Shown as it was before what is tried out: turn that on again to move it" : fixed ? "Decided by what must hold: not moved here" : "Drag across to try it there (arrow keys step it); kept from the card in the view"}">${esc(as.text(r.value))}</td>`
    + `<td class="${r.by === "free" || fixed ? "muted" : ""}">${isLocked(r) ? `<button class="lockwhy" data-why title="What decides it">🔒</button> ` : ""}${esc(r.by)}${off ? `<div style="color:var(--bad);font-weight:600;font-size:11px" title="It gave way to firmer things: ${esc(as.text(r.value))}, where ${kept ? "what is kept" : "the script"} says ${esc(as.text((kept ?? r.own).value))}">off ${esc(as.text(r.off))}</div>` : ""}</td>`
    + `<td><select class="mini" style="width:7.5em" ${fixed ? "disabled" : ""}>${options.join("")}</select></td>`
    + `<td class="num">${said?.within != null && kept ? `<input type="number" step="any" style="width:4em" value="${+(said.within / as.unit).toPrecision(4)}" title="To within (${esc(as.name)})">` : said?.within != null ? `<span class="muted">${esc(String(+(said.within / as.unit).toPrecision(4)))}</span>` : ""}</td>`
    + `<td style="white-space:nowrap">${kept?.yours ? `<button class="mini" data-share title="Yours (a draft in your layer over the model): keep it for everyone, in the model's own generated file">↑</button>` : ""}${kept ? `<button class="mini" data-let title="Let go of what is kept of it: as the script says">×</button>` : ""}</td>`;
  if (off) tr.style.background = "color-mix(in srgb, var(--bad) 8%, transparent)";
  const select = tr.querySelector("select");
  select.value = kept ? selectValue(kept.tier) : "script";
  select.onchange = async () => {
    let v = select.value;
    if (v === "script") return keep(r.address, r.value, null);
    if (v === "custom") {
      const n = Number(prompt("Its level: a whole number (measured 80, held 70, dragged 60, hint 40, routed 30, fallback 20)", kept?.tier.level ?? 70));
      if (!Number.isInteger(n)) return (select.value = kept ? selectValue(kept.tier) : "script");
      v = String(n);
    }
    return keep(r.address, kept?.value ?? r.value, engineTier(v, kept?.tier.within));
  };
  const within = tr.querySelector("input");
  if (within) within.onchange = () => {
    const w = Number(within.value) * as.unit;
    if (!(w > 0)) return msg("How near it is weighed is more than none.", true);
    return keep(r.address, kept.value, engineTier(kept.tier, w));
  };
  const cell = tr.children[1];
  tr.dataset.address = r.address;
  if (moving?.params.has(r.address)) tr.classList.add("pmoves");
  // (Locked: what decides it, below it, at a click.)
  tr.querySelector("button[data-why]")?.addEventListener("click", () => whyLocked(tr, r));
  if (!fixed) {
    const tier = kept ? engineTier(kept.tier) : undefined;
    cell.style.cursor = "ew-resize";
    cell.tabIndex = 0;
    cell.onpointerdown = (e) => {
      const x0 = e.clientX, t = live(r, as, tier, cell, keep);
      try { cell.setPointerCapture(e.pointerId); } catch {}
      document.body.style.cursor = "ew-resize";
      cell.onpointermove = (m) => t.set(r.value + Math.round(m.clientX - x0) * as.step);
      // (Let go of: kept where it was moved; taken away, or Escape pressed before it is let go of: nothing kept.)
      t.done = () => {
        cell.onpointermove = cell.onpointerup = cell.onpointercancel = null;
        try { cell.releasePointerCapture(e.pointerId); } catch {}
        document.body.style.cursor = "";
      };
      cell.onpointerup = () => t.end(true);
      cell.onpointercancel = () => t.end(false);
    };
    // (Stepped by the arrow keys, as it is dragged: ← ↓ less, → ↑ more, by its step; with shift ten times as far, with alt a
    // tenth. Kept once it is left alone a moment, or Enter is pressed; Escape: nothing kept. Enter, not stepped: typed.)
    let t = null, idle = null;
    cell.onkeydown = (e) => {
      const way = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (way) {
        e.preventDefault();
        t ??= live(r, as, tier, cell, keep);
        t.done = () => { t = null; clearTimeout(idle); };
        t.set(t.value + way * as.step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1));
        clearTimeout(idle);
        idle = setTimeout(() => t?.end(true), 900);
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); return t ? t.end(true) : typeIn(r, as, cell, tier, keep); }
      if (e.key === "Escape" && t) { e.preventDefault(); e.stopPropagation(); t.end(false); }
    };
  }
  tr.querySelector("button[data-let]")?.addEventListener("click", () => keep(r.address, r.value, null));
  tr.querySelector("button[data-share]")?.addEventListener("click", async () => {
    const w = await model.share([`param ${r.address}`]);
    if (w.error) msg(w.error, true);
  });
  if (kept?.yours) tr.children[0].title = `${r.address}: yours, a draft (in your layer over the model, kept for nobody else yet)`;
  if (kept?.scratch) tr.children[0].title = `${r.address}: tried out (in this browser only, kept nowhere yet): keep it from the card in the view`;
  return tr;
}

/** A param's value as it is moved (dragged, or stepped by keys): the model settled with it at each value it is set to, as
 *  a node is dragged (only the latest settled; every view shows it, and the other params' values follow). `end(keep)`:
 *  let go of, kept where it was moved (tried out), or nothing kept and shown as built; `done`, said first. Escape, before
 *  it is let go of: nothing kept. */
function live(r, as, tier, cell, keep) {
  const h = { value: r.value, next: null, busy: false, error: null, idle: null, done: null, over: false };
  const settle = async () => {
    if (h.busy || h.next == null) return;
    const value = h.next;
    h.next = null;
    h.busy = true;
    const s = await model.paramDrag(r.address, value, tier);
    h.busy = false;
    if (s.error) h.error = s.error;
    else if (!h.over) { h.error = null; showSettling(s.bodies, s.params); showValues(s.params, r.address); }
    if (h.next != null) settle();
    else h.idle?.();
  };
  const escape = (k) => {
    if (k.key !== "Escape") return;
    k.preventDefault();
    k.stopPropagation();
    h.end(false);
  };
  document.addEventListener("keydown", escape, true);
  h.set = (value) => {
    if (h.over || value === h.value) return;
    h.value = h.next = value;
    cell.textContent = as.text(value);
    settle();
  };
  h.end = async (keepIt) => {
    if (h.over) return;
    h.over = true;
    h.done?.();
    document.removeEventListener("keydown", escape, true);
    h.next = null;
    if (h.busy) await new Promise((done) => (h.idle = done));
    await model.grabEnd(false);
    if (h.error && keepIt) msg(`It cannot be so: ${h.error}`, true);
    if (keepIt && h.value !== r.value) return keep(r.address, h.value, tier);
    // (Nothing kept: shown as built again.)
    cell.textContent = as.text(r.value);
    if (h.value !== r.value) { for (const o of Object.values(views)) exactFor(o); if (last) showValues(last, null); }
  };
  return h;
}

/** A param's value typed in its cell, in the unit it is shown in (of a length in feet and inches: `8' 3 1/2"`, or
 *  inches): Enter keeps it (tried out), Escape or leaving it does not. */
function typeIn(r, as, cell, tier, keep) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = as.name === "in" ? as.text(r.value) : String(+(r.value / as.unit).toPrecision(6));
  input.style.cssText = "width:7em;text-align:right;font:inherit";
  cell.textContent = "";
  cell.appendChild(input);
  input.focus();
  input.select();
  const back = () => { cell.textContent = as.text(r.value); cell.focus(); };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); return back(); }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = as.name === "in" ? inches(input.value) : Number(input.value);
    if (!Number.isFinite(v)) return msg(`Not a ${as.name === "in" ? "length (8' 3 1/2\", or inches)" : "number"}: ${input.value}`, true);
    input.onblur = null;
    cell.textContent = as.text(v * as.unit);
    keep(r.address, v * as.unit, tier);
  };
  input.onblur = back;
}
/** A length typed in feet and inches (`8' 3 1/2"`, `8'`, `3 1/2`, `99.5`), in inches; NaN where it is not one. */
function inches(t) {
  const m = /^\s*(-)?\s*(?:(\d+(?:\.\d+)?)\s*')?\s*(?:(\d+(?:\.\d+)?)?\s*(?:(\d+)\s*\/\s*(\d+))?)\s*"?\s*$/.exec(t);
  if (!m || (!m[2] && !m[3] && !m[4])) return NaN;
  const v = 12 * Number(m[2] ?? 0) + Number(m[3] ?? 0) + (m[4] ? Number(m[4]) / Number(m[5]) : 0);
  return m[1] ? -v : v;
}

/** What decides a locked param, in a row below it (again: gone): held as a part, or what must hold that it is of. */
async function whyLocked(tr, r) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains("pwhy")) return next.remove();
  const why = document.createElement("tr");
  why.className = "pwhy";
  why.innerHTML = `<td colspan="6" class="muted">…</td>`;
  tr.after(why);
  const td = why.firstElementChild;
  if (r.by === "part held") {
    td.textContent = "Held as a part: it is as the part it is of was settled, which is not settled again here.";
    return;
  }
  const m = await model.mustsOf(r.address);
  td.innerHTML = m.error ? esc(m.error) : m.length
    ? `Decided by what must hold, among: <ul>${m.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : "Decided by what must hold, though no one thing of it moves with it here.";
}

/** The node chosen in a view, and the free params that would move it (`ways`), marked in the table: or null. */
let moving = null;
document.addEventListener("fettled:chosen", async (e) => {
  const node = e.detail?.kind === "bodypart" && e.detail.value?.what === "node" ? e.detail.value.name : null;
  if ((moving?.node ?? null) === node) return;
  moving = null;
  if (node) {
    const w = await model.ways(node);
    if (!w.error) moving = { node, params: new Set(w.params.map(([a]) => a)) };
  }
  const chip = $("paramsMoves");
  if (chip) {
    chip.hidden = !moving;
    if (!moving?.params.size) view.movesOnly = false;
    chip.disabled = !moving?.params.size;
    chip.setAttribute("aria-pressed", String(view.movesOnly));
    chip.textContent = !moving ? "" : moving.params.size ? `Move ${moving.node.split("/").pop()} (${moving.params.size})` : `Nothing free moves ${moving.node.split("/").pop()}`;
    chip.title = !moving ? "" : moving.params.size ? `Only the free params that would move ${moving.node}, the node chosen (marked in the table)` : `${moving.node}, the node chosen, is held where it is by what must hold`;
  }
  draw();
});

/** What was read, kept: each listed with what it says, to be let go. (A param read is kept as it is held: at the level
 *  measured, to within so much, in the table above.) */
function renderReadings(p) {
  const box = $("paramsRead");
  const readings = Object.entries(p.readings ?? {});
  const said = (r) => (r.what.kind === "is" ? `${r.what.param} = ${r.what.value}` : `${r.what.kind} ${[r.what.a, r.what.b].filter(Boolean).join(", ")}${r.what.value != null ? ` = ${r.what.value}` : ""}`);
  box.innerHTML = readings.length ? `<div class="muted" style="font-size:11px">Read (measured), kept beside the script:</div>`
    + readings.map(([n, r]) => `<div>${esc(n)}: ${esc(said(r))} ± ${r.within} <button class="mini" data-unread="${esc(n)}" title="Let this reading go">×</button></div>`).join("") : "";
  for (const b of box.querySelectorAll("button[data-unread]")) b.onclick = () => model.read(b.dataset.unread, null);
}
