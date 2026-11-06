// What is tried out (docs/layers.md: the scratch layer, over yours): a param's value dragged or set in the Params tool,
// and a node, face or part dragged in a 3D view, land here first, kept by this page alone (in this browser, for this
// model; never in the project, nor seen by others in a session). Its card stands over the 3D view last used: each thing
// tried, to let go of or keep alone; whether it is built in (off: the model as it was before, to compare); the last
// change undone and made again; all of it let go of; or all of it kept in your layer (in a session, everyone's), as it
// was tried or as firmly as is chosen (held, measured, required: a constraint).

import { $, esc } from "../ui.js";
import { model, scratch, scratchKeys, storage } from "../project.js";
import { msg } from "../shell/panel.js";
import { shown } from "../shell/params.js";
import { views, active } from "./state.js";

/** How firmly what is kept is kept: as it was tried, or at a level (as the engine has a tier). */
const AS = [["", "as tried"], ["70", "held"], ["80", "measured"], ["must", "required"]];
const tierOf = (v) => (v === "" ? null : v === "must" ? "must" : { at: { level: Number(v), within: 1 } });

/** The params last read (as `params` answers), to say what each thing tried is. */
let said = null;

/** The card, over the 3D view last used, as what is tried out now is. `p`: the params as last read, where they are new. */
export function renderScratch(p) {
  if (p !== undefined) said = p;
  const card = $("scratch3d");
  if (!card) return;
  const keys = scratchKeys();
  placeScratch();
  card.hidden = !keys.length && !scratch.back.length && !scratch.ahead.length;
  if (card.hidden) return;
  const params = new Map((said?.params ?? []).map((r) => [`param ${r.address}`, r]));
  const drags = new Map((said?.drags ?? []).map((d) => [d.key, d]));
  const short = (a) => a.split("/").slice(-2).join("/");
  const rows = keys.map((k) => {
    const r = params.get(k), d = drags.get(k);
    const what = k.startsWith("param ") ? short(k.slice(6)) : d ? `drag ${short(d.of)}` : k;
    const as = r ? shown(r.measure, said?.units) : shown("length", said?.units);
    const now = r?.kept ? `${esc(as.text(r.kept.value))}${r.off != null && r.off > 1e-6 * Math.max(1, Math.abs(r.value)) ? ` <span class="bad">off ${esc(as.text(r.off))}</span>` : ""}` : d ? (d.off > 0.5 ? `<span class="bad">off ${esc(as.text(d.off))}</span>` : "on its ray") : "";
    return `<div class="srow" data-key="${esc(k)}"><span class="sname" title="${esc(k)}">${esc(what)}</span><span class="sval">${scratch.on ? now : ""}</span>`
      + `<button class="mini" data-keep title="Keep this alone, in your layer, as it was tried">↓</button><button class="mini" data-let title="Let go of this">×</button></div>`;
  });
  const shared = storage.sharedWithOthers();
  card.innerHTML = `<div class="shdr"><label title="Built in, or not: off, the model is shown as it was before what is tried out, to compare"><input type="checkbox" data-on ${scratch.on ? "checked" : ""}> <b>Trying out</b> <span class="muted">${keys.length}</span></label>`
    + `<span class="sgap"></span><button class="mini" data-undo title="Undo the last change to what is tried out" ${scratch.back.length ? "" : "disabled"}>↶</button><button class="mini" data-redo title="Make it again" ${scratch.ahead.length ? "" : "disabled"}>↷</button></div>`
    + `<div class="srows">${rows.join("") || `<div class="muted">Nothing now.</div>`}</div>`
    + `<div class="sfoot"><button class="mini" data-clear ${keys.length ? "" : "disabled"} title="Let go of all of it: the model as it was (undoable)">Clear</button><span class="sgap"></span>`
    + `<select class="mini" data-as title="How firmly it is kept: as it was tried, or at a level (required: a constraint)">${AS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select>`
    + `<button class="mini" data-keepall ${keys.length && scratch.on ? "" : "disabled"} title="${shared ? "Keep all of it in your layer, which everyone in this session has" : "Keep all of it in your layer (a draft, yours till it is kept for everyone)"}">${shared ? "Keep for everyone" : "Keep"}</button></div>`;
  const run = async (p) => { const w = await p; if (w?.error) msg(w.error, true); };
  card.querySelector("input[data-on]").onchange = (e) => run(model.scratchOn(e.target.checked));
  card.querySelector("button[data-undo]").onclick = () => run(model.scratchStep(false));
  card.querySelector("button[data-redo]").onclick = () => run(model.scratchStep(true));
  card.querySelector("button[data-clear]").onclick = () => run(model.clearScratch());
  card.querySelector("button[data-keepall]").onclick = () => run(model.keepScratch(null, tierOf(card.querySelector("select[data-as]").value)));
  for (const row of card.querySelectorAll(".srow")) {
    const k = row.dataset.key;
    row.querySelector("button[data-let]").onclick = () => run(model.letGo([k]));
    row.querySelector("button[data-keep]").onclick = () => run(model.keepScratch([k]));
    row.querySelector(".sname").onclick = () => { if (k.startsWith("param ")) document.dispatchEvent(new CustomEvent("fettled:find-param", { detail: k.slice(6) })); };
  }
}

/** The card with the 3D view last used. */
function placeScratch() {
  const v = views[active], card = $("scratch3d");
  if (v?.pane && card.parentNode !== v.pane) v.pane.append(card);
}

scratch.listeners.add(() => renderScratch());
// (Undone and made again by ⌘Z and ⌘⇧Z, where nothing is typed in, no photo is worked in, and something was tried: before
// the branch's own undo, which what is tried out is not of.)
window.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
  if (typing || !(e.metaKey || e.ctrlKey) || views[active]?.state?.photo) return;
  const k = e.key.toLowerCase(), redo = (k === "z" && e.shiftKey) || k === "y";
  if ((k !== "z" && !redo) || !(redo ? scratch.ahead : scratch.back).length) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  model.scratchStep(redo).then((w) => w?.error && msg(w.error, true));
}, true);
