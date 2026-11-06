import { idOf, workspaceOf } from "../ids.js";
import { openDoc, setInfo } from "../shell/dock.js";
import { BranchWork, merger } from "../work.js";
import { msg } from "../shell/panel.js";
import { viewKey } from "./views.js";
// A proposal shown in the views: a change to the model's files that someone has made in an
// issue, as the members before and after it with what changes between them, and a strip in
// each view to look at either side and to apply, reject or revert it where it is seen.

import { $, esc } from "../ui.js";
import { workspace } from "../workspace.js";
import { active, sel, st, views } from "./state.js";
import { openIssue, renderIssues } from "./issues.js";
import { members, rebuildModel } from "./parts.js";
import { model, project, storage } from "../project.js";
import { modelBodies } from "./exact.js";

/**
 * The proposal shown, as the workspace has worked it out: { before, after (the members the scan is asked about),
 * changes (by path), diff (text), offer (what can be done with it now), files (what each side differs by) }; and,
 * built here from those files, `sides`: { before, after (every part of the model on that side: its members, its
 * sheets, its parts from a library, its bolts), bodies: { before, after } (each side's, as the exact view draws them),
 * changes (of all of those, by path) }. None where a side does not build here: then the model as it is is shown, the
 * workspace's changes coloured.
 */
export let diff = null;
// (The sides built are kept while the model is as it was, the last few proposals looked at: by the proposal, the
// build of the model, and the workspace's of it. Going back to one, or from one to another and back, builds nothing.)
const builtSides = new Map();

/** What a proposal does to each part, by its path: "added", "removed" or "moved" (its bodies not the same: by the
 *  body addresses under its path, `root` the model's name its paths start with). */
function changesBetween(before, after, root) {
  const shapes = (bodies) => {
    const out = new Map();
    for (const b of bodies ?? []) { const path = root ? `${root}/${b.address}` : b.address; out.set(path, (out.get(path) ?? "") + JSON.stringify(b.body)); }
    return out;
  };
  const was = shapes(before.bodies), will = shapes(after.bodies), out = {};
  const had = new Set(before.members.map((m) => m.path)), has = new Set(after.members.map((m) => m.path));
  for (const m of after.members) { if (!had.has(m.path)) out[m.path] = "added"; else if (was.get(m.path) !== will.get(m.path)) out[m.path] = "moved"; }
  for (const m of before.members) if (!has.has(m.path)) out[m.path] = "removed";
  return out;
}

/** Each side of the proposal as the engine here builds it from the side's files: every part, with what the scan says of those it is asked about. */
async function buildSides(d) {
  const entry = project.current();
  if (!d.files?.after || !entry) return null;
  // (The files are by their paths in the workspace's repository: here, by their ids in it.)
  const side = async (files, said) => {
    const r = await model.partsWith(Object.fromEntries(Object.entries(files).map(([path, text]) => [idOf(workspaceOf(entry), path), text])));
    if (r.error) return null;
    const scan = new Map(said.map(({ faces, role, ...what }) => [what.path, what]));
    return { members: r.members.map((m) => ({ ...m, ...scan.get(m.path) })), bodies: Array.isArray(r.bodies) ? r.bodies : [] };
  };
  const after = await side(d.files.after, d.after);
  if (!after) return null;
  // (Before: the model as it is, unless the proposal is shown as it was made.)
  const before = d.files.before ? await side(d.files.before, d.before) : null;
  return d.files.before && !before ? null : { before, after };
}

/** Two versions of some files shown the way a proposal is, each side the whole model with them. */
async function versionsDiff(p) {
  const v = p.versions, side = async (files) => {
    const r = await model.partsWith(files);
    return r.error ? null : { members: r.members, bodies: Array.isArray(r.bodies) ? r.bodies : [] };
  };
  const [before, after] = await Promise.all([side(v.mine), side(v.theirs)]);
  const root = (members ?? [])[0]?.path.split("/")[0] ?? "", note = [v.note, !before && "Ours does not build, so it cannot be drawn.", !after && "Theirs does not build, so it cannot be drawn."].filter(Boolean).join(" ");
  const offer = { before: "Ours", after: "Theirs", note };
  if (!before || !after) return { offer, changes: {}, before: [], after: [] };
  return { offer, changes: {}, before: [], after: [], sides: { before: before.members, after: after.members, bodies: { before: before.bodies, after: after.bodies }, changes: changesBetween(before, after, root) } };
}

/** The lines two versions of a file differ by, as a few words of each: for what no part of the model shows. */
const linesApart = (lib, path, mine, theirs) => {
  const take = (of, other) => (of == null ? ["(gone)"] : lib.changed_lines(other ?? "", of).length ? [...lib.changed_lines(other ?? "", of)].slice(0, 3).map((n) => `${n}: ${of.split("\n")[n - 1]}`) : []);
  return `${path}. Ours, line ${take(mine, theirs).join(" | ")}. Theirs, line ${take(theirs, mine).join(" | ")}.`;
};

/**
 * Shows two versions of some files (`mine`, `theirs`: path → text, or null: gone) in the views, as a proposal is shown:
 * the parts each changes coloured, either side or both. `choose(side)`: "mine" or "theirs" stays, in the merge.
 */
export async function showVersions({ mine, theirs, choose }) {
  const lib = await merger();
  const note = Object.keys(mine).map((path) => linesApart(lib, path, mine[path], theirs[path])).join(" ");
  // (A file gone on one side: the model on that side has what is kept for it, there being nothing to say instead.)
  const has = (files) => Object.fromEntries(Object.entries(files).filter(([, t]) => t != null));
  openDoc(viewKey(true));
  await selectProposal({ commit: `versions:${JSON.stringify(mine).length}:${Date.now()}`, mode: "both", versions: { mine: has(mine), theirs: has(theirs), choose, note } });
}

export async function loadDiff() {
  const p = sel.proposal;
  if (!p) { diff = null; return; }
  if (p.versions) {
    const d = await versionsDiff(p);
    if (sel.proposal?.commit === p.commit) diff = d;
    return;
  }
  const d = await workspace.diff(p.commit);
  if (d.error) { diff = null; if (views[active]) setInfo(views[active].key, d.error); return; }
  const key = `${p.commit}|${model.state?.version}|${d.model_rev}|${d.offer?.state}`;
  if (!builtSides.has(key)) {
    builtSides.set(key, await buildSides(d));
    while (builtSides.size > 6) builtSides.delete(builtSides.keys().next().value);
  }
  const built = builtSides.get(key);
  if (sel.proposal?.commit !== p.commit) return;
  if (built) {
    const before = built.before ?? { members: members ?? [], bodies: modelBodies() ?? [] }, root = (members ?? [])[0]?.path.split("/")[0] ?? "";
    d.sides = { before: before.members, after: built.after.members, bodies: { before: before.bodies, after: built.after.bodies }, changes: changesBetween(before, built.after, root) };
  }
  diff = d;
}

/// What floats over a view (its proposal's strip, whom it follows) sits under its toolbar, which wraps to more rows in a narrow pane (and would cover it).
export function placeDiffbar(v) {
  v.floats.style.top = `${v.tools.offsetTop + v.tools.offsetHeight + 8}px`;
}

/** The entry of a proposal in its issue's thread (the workspace's state has it). */
/** What merging, rejecting or reverting a proposal does, for its buttons: `{ label, title }`, the title saying it in full (it is versioning,
 *  not the files alone). `branch`: the one it lands on (this page's). Each is a commit, or a branch set aside: undone the same way, so
 *  none is asked twice. */
export function proposalWords(action, branch = storage.work?.base?.branch ?? storage.work?.last?.branch) {
  const on = branch ?? "this branch";
  return {
    apply: { label: `Merge into ${esc(on)}`, title: `Merge the proposal's branch into ${on}: a commit, by you, that everyone on ${on} then builds from. Your files change with it. Revert takes it back with another commit` },
    revert: { label: "Revert", title: `Undo it on ${on} with a new commit, by you: the merge stays in the history, and it can be merged again` },
    reject: { label: "Reject", title: "Set it aside: its branch is kept, as rejected; nothing on the branch you are on changes" },
  }[action];
}

export const proposalEntry = (p) => st?.issues.find((i) => i.id === p.issue)?.entries.find((e) => e.kind === "proposal" && e.n === p.n) ?? null;

/// The strip in each view for the proposal shown: which it is (click: its card in the thread), what the
/// service says it offers now (`offer`: its state, what the two sides are, what can be done), the sides to
/// look at, and the action itself: so what is seen can be kept, or taken back, where it is seen.
export function renderDiffBars() {
  for (const v of Object.values(views)) {
    const p = sel.proposal;
    v.diffbar.hidden = !p;
    if (!p) continue;
    if (p.versions) {
      const n = Object.keys(diff?.sides?.changes ?? {}).length, names = { before: "Ours", after: "Theirs", changed: "Changed", both: "Both" };
      v.diffbar.innerHTML =
        `<span class="pname">Conflict</span><span class="muted">${!diff ? "building both…" : diff.sides ? `${n} part${n === 1 ? "" : "s"} differ` : ""}</span>` +
        Object.keys(names).map((m) => `<button data-m="${m}" class="${m === p.mode ? "on" : ""}">${names[m]}</button>`).join("") +
        `<button data-choose="mine" class="go" title="git checkout --ours: use your version">Use ours</button><button data-choose="theirs" class="go" title="git checkout --theirs: use their version">Use theirs</button><button data-m="" title="Decide later">×</button>` +
        (diff?.offer?.note ? `<div class="pnote">${esc(diff.offer.note)}</div>` : "");
      for (const b of v.diffbar.querySelectorAll("button[data-m]")) b.onclick = () => (b.dataset.m ? selectProposal({ ...p, mode: b.dataset.m }) : selectProposal(null));
      for (const b of v.diffbar.querySelectorAll("button[data-choose]")) b.onclick = () => { p.versions.choose(b.dataset.choose); selectProposal(null); };
      placeDiffbar(v);
      continue;
    }
    const e = proposalEntry(p), o = diff?.offer, n = diff ? Object.keys(diff.sides?.changes ?? diff.changes).length : 0, what = diff?.sides ? "part" : "member";
    const names = { before: o?.before ?? "Before", after: o?.after ?? "After", changed: "Changed", both: "Both" };
    const w = o?.action && proposalWords(o.action), rej = proposalWords("reject");
    const act = !o?.action ? "" : `<button data-act="${o.action}" class="go" ${o.enabled ? "" : "disabled"} title="${esc(o.enabled ? w.title : o.note)}">${w.label}</button>${o.action === "apply" && o.state === "open" ? `<button data-act="reject" title="${esc(rej.title)}">${rej.label}</button>` : ""}`;
    v.diffbar.innerHTML =
      `<a href="#" class="pname" title="${esc(e?.title ?? "")} — show it in the thread">#${p.issue} proposal ${p.n}</a>` +
      `<span class="pstate ${esc(o?.state ?? "")}">${!diff ? "loading" : esc(o?.label || o?.state || "")}</span>` +
      (diff ? `<span class="muted">${n} ${what}${n === 1 ? "" : "s"} ${o?.action === "revert" && !o.as_proposed ? "would change back" : "change"}</span>` : "") +
      ["before", "after", "changed", "both"].map((m) => `<button data-m="${m}" class="${m === p.mode ? "on" : ""}">${esc(names[m])}</button>`).join("") + act + `<button data-m="">×</button>` +
      (o?.note ? `<div class="pnote">${esc(o.note)}</div>` : "");
    for (const b of v.diffbar.querySelectorAll("button[data-m]")) b.onclick = () => (b.dataset.m ? selectProposal({ ...p, mode: b.dataset.m }) : selectProposal(null));
    for (const b of v.diffbar.querySelectorAll("button[data-act]")) b.onclick = () => actOnProposal(p, b.dataset.act);
    v.diffbar.querySelector(".pname").onclick = async (ev) => {
      ev.preventDefault();
      await openIssue(p.issue);
      $(`prop-${p.issue}-${p.n}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    placeDiffbar(v);
  }
}

/// Merges, rejects or reverts a proposal (from its card or from a view's strip): at once, each being a commit or a branch set aside,
/// undone the same way. It stays shown: its strip then says what it has become.
export async function actOnProposal(p, action) {
  const r = await workspace.call("proposal", { issue: p.issue, n: p.n, action });
  if (r.error) { alert(r.error); renderIssues(); renderDiffBars(); return; }
  // (Merged or reverted, the branch has moved on: where this page's model is of a branch as it was (a session's commit, a branch
  // on GitHub), it is brought in, as a pull brings it, and in a session everyone is over it. A host's files on disk moved with it.)
  if (action !== "reject" && storage.work instanceof BranchWork) {
    await storage.work.pull().catch((e) => msg(`It is merged, but not here yet: ${e.message ?? e}. Pull it in from Changes.`, true));
  }
  // Done: the proposal is no longer what is looked at, the model is, as the action left it (it is built again
  // from the files as they now are, and shown when it is).
  if (sel.proposal?.commit === p.commit) await selectProposal(null, true);
  renderIssues();
}

export async function selectProposal(p, quiet) {
  const changed = p?.commit !== sel.proposal?.commit;
  sel.proposal = p ? { ...p } : null;
  if (changed) { diff = null; renderDiffBars(); await loadDiff(); }
  renderDiffBars(); rebuildModel();
  if (!quiet) renderIssues();
}
