import { addTool, defineType } from "../shell/dock.js";
import { bindSkeleton } from "./skeleton.js";
// The scene: the open project's model in 3D, with what has been put in it and, where the
// project has them, a point cloud and other people (workspace.js says what a workspace is, and who
// keeps it). On the page it is:
//   - panes: three 3D views (glview.js) and the issue board; any of the 3D views can be clipped
//     to a slab, which is what a section is;
//   - in the browser: the objects (the model's parts, slabs, polylines; with a point cloud, it and its
//     selections and planes; issues) and the views kept;
//   - on the right: the issues and their threads, with proposals (alone: the model's checks);
//   - in the header: Back / Forward through views followed, and who is here.
//
// Nobody's view is moved for them. A comment can carry a view link (a partial view state: only
// what matters); following it changes just that and can be undone with Back.
//
// What is only of a point cloud, or only of a workspace that is shared, is asked of the workspace where
// it is used (`hasPoints()`, `shared()`): nothing here is set up for one kind of project.

import { $, el } from "../ui.js";
import { reached } from "../times.js";
import { model } from "../project.js";
import * as objects from "../objects.js";
import { workspace } from "../workspace.js";
import { say } from "../shell/panel.js";
import { live, hasPoints, sel, setLive, setState, views } from "./state.js";
import { freshPlaces, loadMembers, loadRatios, rebuildModel } from "./parts.js";
import { cloudLoaded, forgetPoints, loadCloud, syncHighlights } from "./points.js";
import { syncSlabs } from "./slabs.js";
import { drawing, endDrawing } from "./polylines.js";
import { diff, loadDiff, placeDiffbar, proposalEntry, renderDiffBars } from "./proposals.js";
import { renderLayers, syncLayers } from "./views.js";
import { drawOverlay, initOverlay } from "./overlay.js";
import { rebuildMarks } from "./marks.js";
import { renderChips } from "./chosen.js";
import { bindTree } from "./tree.js";
import { chatLabel, renderChat, renderPeople } from "./people.js";
import { initAccount } from "./account.js";
import { issuesLabel, renderBoard, renderIssues } from "./issues.js";
// (Kinds of thing that nothing here asks for by name: they say what they are, and are asked through kinds.js.)
import "./picked.js";
import "./spaces.js";
import "./commands.js";
import "./drags.js";
import { loadPhotos } from "./photos.js";
import { loadSessions } from "./sessions.js";
import { loadReadings } from "./pointreadings.js";
import { loadRanged } from "./ranged.js";

let hadPoints = null;
/** The workspace's state has been said (again): everything that shows it is brought up to date. */
function onState(s) {
  if (!s) return;
  reached("workspace");
  setState(s);
  // With points the model is seen against them (as glass, on the dark); without, solid, on paper.
  if (hasPoints() !== hadPoints) {
    hadPoints = hasPoints();
    for (const v of Object.values(views)) v.set({ paper: !hadPoints }, true);
  }
  // What was dragged here is in the workspace's state now.
  if (live?.done) setLive(null);
  syncSlabs();
  const cloudKey = `${s.points?.path}|${(s.clouds ?? []).map((x) => x.address).join()}|${s.points?.min_range}|${s.points?.thin}|${s.drawn}|${s.selections.filter((x) => x.ignored).map((x) => x.id).join()}`;
  if (s.drawn && cloudLoaded !== cloudKey) loadCloud(cloudKey);
  // (The model no longer says point clouds: their points are not drawn.)
  else if (!s.points && cloudLoaded) forgetPoints();
  loadMembers();
  // (The proposal shown was applied, rejected or reverted by someone: what it offers is asked for again.)
  if (sel.proposal && diff?.offer && proposalEntry(sel.proposal) && proposalEntry(sel.proposal).state !== diff.offer.state) loadDiff().then(() => { renderDiffBars(); rebuildModel(); });
  freshPlaces();
  say("workspace", s.loading ? `points: ${s.loading}…` : !workspace.connected ? "the workspace service is not answering" : null);
  if (sel.issue != null && !s.issues.some((i) => i.id === sel.issue)) sel.issue = null;
  syncLayers(); rebuildMarks(); syncHighlights();
  renderChat(); renderPeople(); renderIssues(); renderBoard(); renderLayers(); renderDiffBars(); renderChips();
}

/** Puts the scene on the page, and starts following the project that is open. */
export function initScene() {
  // Tools: the tree of what the project has, and the issues (alone: the model's checks).
  bindTree();
  addTool("project", { title: "Project", el: objects.mount(), side: "left" });
  addTool("issues", { title: "Issues", el: el("div", { id: "issuePanel" }), side: "right", beside: "checks", label: issuesLabel });
  // (The session's chat: everyone's, and with any one of them.)
  addTool("chat", { title: "Chat", el: el("div", { id: "chatPane", class: "chatpane" }), side: "right", beside: "issues", label: chatLabel });
  // A document: the issue board. (The 3D views are views.js's.)
  const board = el("div", { id: "boardPane", class: "board" });
  defineType("board", { title: () => "Issue board", make: () => ({ el: board, shown: renderBoard }) });
  // The header: who is here, and then, apart, this person (their places are kept for them in it).
  initAccount();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sel.drafting) { sel.drafting = false; renderIssues(); } });
  // A polyline being drawn: Enter keeps it, Esc drops it.
  document.addEventListener("keydown", (e) => {
    if (!drawing || e.target.closest?.("input, textarea, [contenteditable]")) return;
    if (e.key === "Enter") endDrawing(true);
    if (e.key === "Escape") endDrawing(false);
  });
  // (Panes change size: the toolbars wrap differently.)
  window.addEventListener("resize", () => { for (const v of Object.values(views)) placeDiffbar(v); });
  initOverlay();
  bindSkeleton(() => drawOverlay());
  workspace.onState(onState);
  // (The model built again: its parts, and its checks.)
  model.onChange(() => { loadMembers(); loadRatios(); renderIssues(); loadPhotos(); loadSessions(); loadReadings(); loadRanged(); });
  // (Its checks found apart, after it is shown: listed when they come.)
  model.onChecked(() => { renderIssues(); objects.render(); });
  // (Its checks made, by what shows them, or made again of other load cases: its issues, and its parts coloured by them.)
  model.onAnalysed(() => { renderIssues(); loadRatios(); });
  // (Parts are coloured by how far they are used, where the checks panel asks for that.)
  for (const id of ["heatMode", "heatCombo"]) $(id).addEventListener("change", loadRatios);
  workspace.watch();
}
