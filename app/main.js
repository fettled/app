// The app: the page's frame (shell/: a dock of documents and tools), the views of a project that
// are opened in it (its drawings, its script, its scene in 3D), and what they are views of (the
// project's files and its model as built: project.js; its workspace: workspace.js).

// (First, so that it sees what goes wrong from the start: report.js.)
import { report, unreached } from "./report.js";
import { homeOf } from "./ids.js";
// (And what it reports by itself, said to whoever it went wrong for.)
import "./trouble-bubble.js";
import { $ } from "./ui.js";
import { onWork, versions } from "./work.js";
import { showVersions } from "./scene/proposals.js";
import { idle, step } from "./times.js";
import { RELAYED, model, project, storage } from "./project.js";
import { workspace } from "./workspace.js";
import { initDock, isOpen, openDoc, openProject } from "./shell/dock.js";
import { renderLists } from "./shell/browser.js";
import { showProjects } from "./shell/projects.js";
import { offerCopyToShare, showReadOnly } from "./shell/copy.js";
import { msg, renderPanel, renderSolving, say } from "./shell/panel.js";
import { HttpStore, githubPlace } from "./store.js";
import { auth } from "./auth.js";
import { loadSheets } from "./drawing.js";
import { files, loadSources } from "./editor.js";
import { initScene } from "./scene/index.js";
import { showRootInAddress, viewKey } from "./scene/views.js";
// (Keys that do things: it listens for them itself.)
import "./shortcuts.js";
import "./machines-tool.js";
import "./nest.js";
import { renderParams } from "./shell/params.js";
import "./buildlog.js";
import { noVersions, showChanges } from "./git-tool.js";
import { offerSessions } from "./share-menu.js";

/** Whether the workspace's documents are laid out as they were left. */
let laidOut = false;
/** Whether the version is said, and ⌘Z bound: once, of whatever versions the page has then. */
let saidOnce = false;
// The model built (opened, or built again, or another root part focused): what shows it is brought up to date (the scene follows the model itself).
model.onChange(async (s, was) => {
  renderPanel();
  renderParams();
  // The workspace opened: its documents as they were left open; the first time, the 3D view (its sheets are drawn after, and do not
  // hold it up). (Another of its root parts focused is not another layout: its views are among them.)
  if (s.file && project.home() && !laidOut) { laidOut = true; openProject(project.home(), () => [viewKey(true)]); showRootInAddress(); }
  renderLists();
  // Its files are read and its sheets shown, neither waiting for the other (and the 3D view for neither).
  await Promise.all([
    loadSources().then(() => {
      // A project whose model does not build is looked at in its script.
      if (s.file && s.error && files[0] && !isOpen(`file:${files[0].path}`)) openDoc(`file:${files[0].path}`, { tab: true });
      renderLists();
    }),
    loadSheets(),
  ]);
});
// A file of the workspace that the model is not built from, changed, or one more or fewer of them.
project.onFiles(() => { if (model.state?.file) loadSources(true); });
// It is being built again (the model as it was is shown meanwhile): that, and how far it has come.
model.onSolving(renderSolving);
// Its sheets drawn: they are listed, and those open are shown.
model.onDrawn(async () => { renderPanel(); renderLists(); await loadSheets(); });
// An engine that would not start: what was waiting for it will not come, which is said where the page says how it is.
model.onBroken((e) => { $("status").textContent = `${e.message}: reload the page`; });

// The scene's documents and tools are said, then the dock is put on the page, the tools where they were left.
initScene();
initDock();
// Which root part the page is of, as its address says, and nothing else: `?workspace=W&part=PATH` (docs/workspaces.md; in the
// location `in` says: the host's, unless it says `browser`, `folder` or `github:owner/name@branch`); neither, none (the workspaces page). One that cannot be opened is said, on the projects page, and
// no other is opened in its place. (Another is gone to by loading the page with it: nothing of the last is left. The
// host has no project of its own: pages of any of them are open at once.)
step("page", "finding where workspaces are kept");
// (First: if GitHub has just sent the page back, its address is put right before anything reads it.)
await auth.boot();
await storage.boot();
// (Whether the host keeps workspaces: asked whatever is opened.)
step("page", "asking the host about workspaces");
await workspace.probe();
idle("page");
const asked = new URLSearchParams(location.search), at = asked.get("at");
let entry = project.inAddress(location.href).entry, kind = asked.get("in") ?? "host", sessionTrouble = null;
// (In a session, the page is of what the session is of, which its log says. Nothing of this is loaded otherwise.)
if (/^#room=/.test(location.hash)) {
  const { askToJoin, joinRoom, roomInAddress } = await import("./session/enter.js");
  const room = roomInAddress();
  try {
    if (!room) throw new Error("the link is incomplete");
    // (Who they will be to the others, and what the others see of them, said first.)
    if (!(await askToJoin(room))) throw Object.assign(new Error("not joined"), { declined: true });
    // (Of the root part the address says, where it is of the session's workspace (the one focused when the link was had); else the one
    // the session was begun on.)
    const said = entry, joined = await joinRoom(room);
    ({ entry, kind } = joined);
    if (said && homeOf(said) === homeOf(entry)) entry = said;
  } catch (e) {
    if (e.declined) sessionTrouble = "You did not join the session: open its link again to join it.";
    else {
      // (What only says it failed, said of what: and sent where it may be, so that it need not be copied out.)
      const what = /failed to fetch|load failed|networkerror/i.test(String(e.message ?? e)) ? unreached() : null;
      const id = await report("join", e, { room: room?.id });
      sessionTrouble = `That session could not be joined: ${e.message ?? e}${what ? ` (${what})` : ""}.${id ? ` This was reported (${id}).` : ""}`;
    }
    entry = null;
    history.replaceState(history.state, "", project.href(null));
  }
}
// (A link to a view: the project as it was at that commit.)
let atTrouble = null;
if (at && entry) await storage.openAt(kind, entry, at).catch((e) => { atTrouble = String(e.message ?? e); });
/** Why the project asked for cannot be opened from where it is, where it cannot. */
const unreachable = () =>
  atTrouble ? `that commit could not be read: ${atTrouble}` :
  !["host", "browser", "folder", RELAYED].includes(kind) && !githubPlace(kind) ? `there is no place "${kind}" workspaces are kept`
  : storage.of(kind) ? null
  : kind === RELAYED ? "it is a session shared by a link, and this address is not all of the link"
  : kind === "host" ? (HttpStore.unreached ? `it is kept on the host this page is from, and ${HttpStore.unreached}: reload the page` : "this page is not served by a fettled host, which it is kept on")
  : !storage.folder ? "it is in a folder on this computer, and none has been opened here"
  : `it is in ${storage.folder.label}, which this browser needs your leave to use again`;
if (!entry) showProjects(sessionTrouble ?? auth.trouble ?? "");
else if (unreachable()) {
  history.replaceState(history.state, "", project.href(null));
  showProjects(`${entry} could not be opened: ${unreachable()}`, { entry, kind });
} else {
  storage.use(kind);
  const r = await project.open(entry, { remember: !at });
  if (r.error) {
    history.replaceState(history.state, "", project.href(null));
    showProjects(`${entry} could not be opened: ${r.error}`);
  } else {
    if (auth.trouble) msg(auth.trouble, true);
    showReadOnly();
    if (/^#view=/.test(location.hash)) import("./scene/links.js").then(({ followViewInAddress }) => followViewInAddress());
    await storage.findWork(entry, () => workspace.myName());
    if (storage.work) {
      branchSaid();
      // (In a session, the menu is that session's: session/enter.js.)
      // (Not of a built-in workspace, which is read-only: a copy of it is.)
      if (storage.store.readOnly) offerCopyToShare();
      else if (!storage.store.session) offerSessions(storage.work);
    } else noVersions();
  }
}
// (A session begun here: the page's versions are the session's from then.)
storage.onUse(() => { if (storage.work) branchSaid(); });
/** Of a project that has versions: looks once at where the branch is; says where the page is and what is waiting, and
 *  a click there brings up the Changes panel. ⌘Z takes back the last save, where saves can be (in a text field, it is the field's own).
 *  (Again where the page's versions are others: of those.) */
function branchSaid() {
  const show = async () => {
    const work = storage.work;
    if (!work) return;
    const s = await work.status();
    say("version", [
      `${s.branch} at ${s.commit?.slice(0, 7) ?? ""}`,
      s.viewing && "HEAD detached",
      s.moved && !s.conflicts.length && `behind ${s.upstream}`,
      s.merging && `merging ${s.merging.branch}`,
      s.conflicts.length && `${s.conflicts.length} unmerged`,
      s.edited.length && `${s.edited.length} changed`,
    ].filter(Boolean).join(" · "));
    const chip = $("status-version");
    chip.title = `${s.repo ?? ""} (${s.branch}): click for what has changed, and the branch`;
    chip.style.cursor = "pointer";
    chip.onclick = () => showChanges();
  };
  const work = storage.work;
  // (Looked at, and nothing moved: what has reached the branch comes in when someone says so.)
  work.fetch().catch(() => {});
  work.followStatus?.();
  show();
  if (saidOnce) return;
  saidOnce = true;
  onWork(show);
  window.addEventListener("keydown", async (e) => {
    const work = storage.work;
    if (!work?.can("undo")) return;
    const k = e.key.toLowerCase(), redo = (k === "z" && e.shiftKey) || k === "y";
    if (!(e.metaKey || e.ctrlKey) || (k !== "z" && !redo) || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? "") || e.target?.isContentEditable) return;
    e.preventDefault();
    if (await (redo ? work.redo() : work.undo())) await project.touched();
    else msg(redo ? "Nothing to redo." : "Nothing to undo.");
  });
}
// Two versions of files, as a proposal's sides are shown (wherever a project is kept).
versions.show = showVersions;
// (Said for what it is: the site not answering, or something of the page's own failing.)
model.watch((e) => { console.error("model:", e); $("status").textContent = e instanceof TypeError && /fetch|network/i.test(e.message) ? "server not reachable" : `page error: ${e?.message ?? e}`; });
