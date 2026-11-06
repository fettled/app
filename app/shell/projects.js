// The workspaces page: every workspace in every place they are kept (storage.locations: the fettled host the page is
// served by, this browser, a folder on this computer, and GitHub, under one header, its repositories found by asking what the App is on), each place a section of its own and its
// workspaces' models (each a root part, opened by itself) by workspace, after those opened last; as tiles, each as it looked when it was last built (previews.js), or as a list.
// A workspace is a folder with history (docs/workspaces.md): a host's repository, a GitHub repository, the folder picked, or one of this browser's.
// In order: Recent, GitHub (signed in to from the page's header), this computer's places, a read-only site's files,
// and the examples last (read from their repository on GitHub, by anyone). Each place can be folded away.
// One clicked is gone to (the page is loaded again with it: project.go); each is a link to it, so one can be opened in
// a tab of its own. A new workspace is made in a place that makes them (a host told where, this browser), and a new model in a
// workspace; a folder is opened from it, or let in again; and where
// the page has no host, a host is gone to. Shown over the page when asked for (the project's name in the header, the
// menu), and where the page is of no project (its address names none, or one that could not be opened: why, said).

import { nameOf, pathIn, workspaceOf } from "../ids.js";
import { $, esc, store, stored } from "../ui.js";
import { EXAMPLES_KIND, project, storage } from "../project.js";
import { EXAMPLES } from "../config.js";
import { previewOf } from "../previews.js";
import { sharedOrigin, tokenLink } from "../store.js";
import { auth } from "../auth.js";
import { files, live } from "../editor.js";

/** Whether the project open can be left: its scripts' edits not saved are let go of, if there are any. */
export const leaving = () => (discarded ||= !files.some((f) => f.text !== f.saved) || confirm("Discard unsaved script edits?"));
let discarded = false;
// (Nor is the page left, or loaded again, with them, unasked.)
// (In a session, what is typed has gone to the others: it is not lost by leaving.)
window.addEventListener("beforeunload", (e) => { if (!discarded && !live.typed && files.some((f) => f.text !== f.saved)) e.preventDefault(); });

/** The pictures shown, as URLs: let go of when the page is put away or drawn again. */
let pictures = [];
const letGo = () => { for (const u of pictures) URL.revokeObjectURL(u); pictures = []; pictureOf.clear(); };
/** The same, by the project each is of. */
const pictureOf = new Map();
/** A project asked for that could not be opened from where it is (`{ entry, kind }`): gone to once it can be. */
let waiting = null;

/**
 * Shows the projects page, the search ready to type into. `said`: why it is shown (a project not opened); `asked`:
 * that project, where it can be opened once its place can be used (a folder let in again).
 */
export async function showProjects(said, asked = null) {
  $("menu").hidden = true;
  $("projects").hidden = false;
  say(typeof said === "string" ? said : "", true);
  waiting = asked;
  // (Not put away where the page is of no project: there is nothing under it.)
  $("projectsClose").hidden = !project.ofPage();
  $("projectsFind").value = "";
  $("projectsFind").focus();
  showView();
  await renderProjects();
}
/** Puts it away (not where the page is of no project). */
function hideProjects() {
  if (!project.ofPage()) return;
  $("projects").hidden = true;
  letGo();
}
/** Says something at the top of the page (none: nothing): what went wrong (`bad`), or what was done. */
function say(text, bad) {
  $("projectsSaid").textContent = text;
  $("projectsSaid").hidden = !text;
  $("projectsSaid").classList.toggle("ok", !bad);
}

/** When something was, said short: "today", "3 days ago", or its date. */
function ago(ms) {
  if (!ms) return "";
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days < 1 ? "today" : days < 2 ? "yesterday" : days < 30 ? `${days} days ago` : new Date(ms).toLocaleDateString();
}
/** What is shown of a project with no picture yet: the first letters of its name. */
const initials = (name) => name.split(/[^A-Za-z]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "·";

/** A project's tile (`p`: as `project.listIn` has it; `kind`: the place it is in; `where`: said of the place, in Recent). */
function tile(p, kind, where = "", over = "") {
  const open = p.path === project.ofPage() && kind === storage.kind;
  const meta = [where, p.changed ? `changed ${ago(p.changed)}` : where ? "" : p.path].filter(Boolean).join(" · ");
  return `<a class="ptile${open ? " open" : ""}" href="${esc(project.href(p.path, kind))}" data-path="${esc(p.path)}" data-in="${esc(kind)}" data-find="${esc(`${p.name} ${p.path}`.toLowerCase())}" title="${esc(p.path)}${open ? " (open)" : ""}">
    <span class="pshot"><span class="pnone">${esc(initials(p.name))}</span></span>
    <span class="ptext"><span class="pname">${esc(p.name)}${open ? ` <span class="popen">open</span>` : ""}</span><span class="pmeta">${esc(meta)}</span></span>${over}
  </a>`;
}
/** A tile that does something rather than open a project (`act`: what, as the click handler knows it). */
const action = (act, mark, name, meta, title) => `<button class="ptile pact" data-act="${act}" title="${esc(title)}"><span class="pshot"><span class="pnone">${mark}</span></span><span class="ptext"><span class="pname">${esc(name)}</span><span class="pmeta">${esc(meta)}</span></span></button>`;
const grid = (tiles) => `<div class="pgrid">${tiles}</div>`;

/** Whether the place is the site's own files, read-only (the examples a published page comes with). */
const readOnlySite = (l) => l.kind === "host" && !!storage.site && !storage.site.writable;

/** What each place's section offers before its projects, as it can be used now. (Nothing is made in a read-only site.) */
function actionsOf(l) {
  const host = l.kind === "host";
  const fresh = project.makesWorkspaces(l.kind) ? action(`new:${l.kind}`, "+", "New workspace…", host ? "with its history from the start" : "kept in this browser", host ? `A new workspace on this host: a git repository with its model in it, which can be shared at once` : `A new workspace in ${l.label}, with its model in it`) : "";
  if (readOnlySite(l)) return "";
  if (host) return l.store ? fresh : action("host", "⇄", "Go to a fettled host…", "where fettled serve is running", "This page is not served by a fettled host: go to one (the app is served by it, with its workspaces)");
  if (l.kind === "folder") {
    const another = action("folder", "▤", storage.folder ? "Open another folder…" : "Open a folder…", "on this computer", "A folder on this computer, as a workspace (this browser lets the page read and write it)");
    if (!storage.folder) return another;
    if (!l.store) return action("letin", "↻", `Let ${storage.folder.dir.name} in again`, "the browser asks once the page is loaded again", `${l.label}: this browser needs your leave to use it again`) + another;
    return action(`model:${l.kind}`, "+", "New model…", `in ${storage.folder.workspace}`, `A new model in ${l.label}: a folder of its own, with its model in it`) + another;
  }
  return fresh;
}

/** A small button on a header, or over a tile. */
const small = (act, text, title, cls = "") => `<button class="pact pheadact ${cls}" data-act="${esc(act)}" title="${esc(title)}" aria-label="${esc(title)}">${text}</button>`;
/** What is done to a repository's place. */
const repoButtons = (l) => small(`model:${l.kind}`, "+", `A new model in ${l.label}: a folder of its own, with its model in it`) + small(`unfollow:${l.kind}`, "×", `No longer list ${l.label} here (edits kept here stay)`);

/** The places folded away, by kind (as the viewer last left them). */
const folded = () => new Set(stored("fettled.projects.folded", []));
/** A place's section, foldable: its header (`head`: buttons after its name), then what is in it. */
const placeSection = (kind, label, head, body) =>
  `<details class="pgroup pplace" data-place="${esc(kind)}"${folded().has(kind) ? "" : " open"}><summary><h3 class="pplacehead">${esc(label)}${head}</h3></summary>${body}</details>`;

/** Who is signed in to GitHub, in the page's header; or a way to sign in. */
function githubHeader() {
  const signedIn = auth.signedIn();
  $("projectsGithub").innerHTML = signedIn
    ? `<span class="pwho" title="Signed in to GitHub">${esc(auth.login())}</span>${small("signout", "Sign out", "GitHub is told to take this sign-in back, and it is forgotten here. Edits kept here stay")}`
    : auth.can() ? small("signin", "Sign in with GitHub", "Goes to GitHub, and comes back here", "gsignin") : "";
}

/** All of GitHub under one header: a repository with one project, its tile among the others; any other under a sub-header of its own. */
function githubSection(places) {
  const signedIn = auth.signedIn(), hidden = storage.hiddenKinds().length;
  const head = [
    signedIn && small("refresh", "⟳", "Look again for the repositories the App is on"),
    signedIn && auth.app.slug && `<a class="pheadact" target="_blank" rel="noopener noreferrer" href="${esc(`${auth.app.login}/apps/${encodeURIComponent(auth.app.slug)}/installations/new`)}" title="Install the App on more repositories, then come back and look again">Install on more…</a>`,
    hidden ? small("unhide", `Show ${hidden} put away`, "List again the repositories put away here") : "",
  ].filter(Boolean).join("");
  const byName = action("github", "+", "Add a repository…", "by its name, owner/name", "A branch of a repository on GitHub, by its name: read from there, and committed to if you may");
  const github = places.filter((l) => l.kind.startsWith("github:") && !l.examples), ones = [], others = [];
  for (const l of github) {
    const said = listing.get(l.kind), ps = [...(said?.projects ?? [])];
    // (A file of the page's project, looked at by itself, in this place: it is no project of its own.)
    if (storage.kind === l.kind && project.ofPage() && !ps.some((p) => p.path === project.ofPage())) ps.push({ name: project.ofPage(), path: project.ofPage(), changed: 0 });
    if (ps.length === 1 && !said?.error) ones.push(tile(ps[0], l.kind, l.label, small(`unfollow:${l.kind}`, "×", `No longer list ${l.label} here (edits kept here stay)`, "ontile")));
    else others.push(`<div class="pgroup ghrepo" data-place="${esc(l.kind)}"><h4 class="phead">${esc(l.label)}${repoButtons(l)}</h4>${said?.error ? `<p class="muted pnone-here">${esc(said.error)}</p>` : !said ? `<p class="muted pnone-here">Reading…</p>` : !ps.length ? `<p class="muted pnone-here">No models here yet.</p>` : ""}${grid(ps.map((p) => tile(p, l.kind)).join(""))}</div>`);
  }
  const none = !github.length ? `<p class="muted pnone-here">${signedIn ? "The App is not on any repository of yours yet: install it, then look again." : auth.can() ? "Sign in (at the top) to reach your repositories, or add one by its name." : "Add a repository by its name."}</p>` : "";
  return placeSection("github", "GitHub", head, `${none}${grid(ones.join("") + byName)}${others.join("")}`);
}

/** A place's models, by workspace and the folder in it each is in (`ps`: none, where it has not been read; `error`: why it could not be). */
function placeBody(l, ps, error) {
  const groups = new Map(), heading = (p) => (p.group ? `${p.workspace} · ${p.group}` : p.workspace);
  for (const p of ps ?? []) (groups.get(heading(p)) ?? groups.set(heading(p), []).get(heading(p))).push(p);
  // (A file of the page's workspace, looked at by itself, in this place: it is no model of its own.)
  if (ps && storage.kind === l.kind && project.ofPage() && !ps.some((p) => p.path === project.ofPage())) groups.set("by itself", [{ name: nameOf(project.ofPage()), path: project.ofPage(), changed: 0 }]);
  const order = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const why = error ? `<p class="muted pnone-here">${esc(error)}</p>` : !ps ? `<p class="muted pnone-here">Reading…</p>` : l.store && !ps.length ? `<p class="muted pnone-here">No workspaces here yet.</p>` : "";
  return why + order.map((g) => `<h4>${esc(g)}</h4>${grid(groups.get(g).map((p) => tile(p, l.kind)).join(""))}`).join("");
}

/** The examples, as their repository has them (each topic a project; each whole thing one by itself). */
function examplesSection(places) {
  const l = places.find((p) => p.examples), said = listing.get(l.kind);
  const head = `<a class="pheadact" target="_blank" rel="noopener noreferrer" href="https://github.com/${esc(EXAMPLES.repo)}" title="Where they are kept: copy one out to start from">${esc(EXAMPLES.repo)}</a>`;
  return placeSection(l.kind, l.label, head, placeBody(l, said?.projects ?? null, said?.error));
}

/** Asks what repositories the App is on. */
async function lookForRepositories() {
  try {
    const more = await storage.refreshReachable();
    if (more) say(`${more} more repositories than can be listed here: open one by name.`, false);
    return true;
  } catch (e) {
    storage.reachableAsked = true;
    say(`GitHub would not say which repositories there are: ${e?.message ?? e}`, true);
    return false;
  }
}

/** How many repositories are read at once. */
const READING_AT_ONCE = 4;
/** What each branch on GitHub was last found to have: `{ projects }` or `{ error }`. */
const listing = new Map();
/** Another drawing of the page has begun: what was being read for this one is drawn by that. */
let drawing = 0;

/** Each project's picture, as it is had (not waited for: the tiles are there first). One had already is there at once. */
function showPictures(within) {
  for (const a of within.querySelectorAll(".ptile[data-path]")) {
    const key = `${a.dataset.in}\n${a.dataset.path}`, had = pictureOf.get(key), show = (url) => { a.querySelector(".pshot").innerHTML = `<img src="${url}" alt="">`; };
    if (had) { show(had); continue; }
    previewOf(a.dataset.path, a.dataset.in).then((url) => {
      if (!url) return;
      pictures.push(url);
      pictureOf.set(key, url);
      if (a.isConnected) show(url);
    });
  }
}
/** The GitHub section as it now stands, in place. (Coalesced: repositories may come in together.) */
let drawn = null;
function drawGithub() {
  drawn ??= requestAnimationFrame(() => {
    drawn = null;
    const places = storage.locations();
    for (const [at, html] of [[$("projectsList").querySelector('[data-place="github"]'), () => githubSection(places)], [$("projectsList").querySelector(`[data-place="${CSS.escape(EXAMPLES_KIND)}"]`), () => examplesSection(places)]]) {
      if (!at) continue;
      const t = document.createElement("template");
      t.innerHTML = html();
      const now = t.content.firstElementChild;
      at.replaceWith(now);
      showPictures(now);
    }
    find();
  });
}
/** Reads each branch on GitHub, a few at a time, each drawn as it comes; the examples among them, brought up to date
 *  first (where nothing is kept here over them). */
async function readGithub(mine) {
  const kinds = [...storage.githubKinds(), EXAMPLES_KIND];
  for (const k of listing.keys()) if (!kinds.includes(k)) listing.delete(k);
  const next = kinds[Symbol.iterator]();
  await Promise.all(Array.from({ length: READING_AT_ONCE }, async () => {
    for (let n = next.next(); !n.done && mine === drawing; n = next.next()) {
      if (n.value === EXAMPLES_KIND) await storage.of(n.value).fastForward().catch(() => {});
      listing.set(n.value, await project.listIn(n.value));
      drawGithub();
    }
  }));
}

/** A model's name where its place has not been read: its folder's, for the model of a folder; its workspace's, for the workspace's own. */
const nameOfPath = (id) => { const parts = pathIn(id).replace(/\.ts$/, "").split("/"), last = parts.pop(); return last === "model" ? parts.pop() ?? workspaceOf(id) ?? last : last; };

/** The page, at once: every place but GitHub, whose repositories are read after it is drawn and come in as they are read. */
async function renderProjects() {
  const mine = ++drawing, places = storage.locations(), list = $("projectsList"), local = places.filter((l) => !l.kind.startsWith("github:"));
  const [lists, recent] = await Promise.all([Promise.all(local.map((l) => (l.store ? project.listIn(l.kind) : null))), project.recent()]);
  if (mine !== drawing) return;
  letGo();
  const of = Object.fromEntries(local.map((l, k) => [l.kind, lists[k]?.projects ?? []]));
  // Recent: of any place (one that cannot be used now, or has not been read yet, by its path).
  const labelOf = (kind) => places.find((l) => l.kind === kind)?.label ?? kind;
  const lately = recent.map((r) => {
    const p = (of[r.in] ?? listing.get(r.in)?.projects)?.find((x) => x.path === r.path) ?? { name: nameOfPath(r.path), path: r.path, changed: 0 };
    return tile(p, r.in, places.length > 1 ? labelOf(r.in) : "");
  });
  const sections = local.map((l, k) => {
    const acts = actionsOf(l);
    return placeSection(l.kind, l.label, "", `${acts ? grid(acts) : ""}${placeBody(l, of[l.kind], lists[k]?.error)}`);
  });
  // Recent, then GitHub, then this computer's places; the host last where it is no place of one's own (a read-only
  // site's examples, or none).
  const last = local.map((l, k) => (l.kind === "host" && !(l.store && !readOnlySite(l)) ? k : -1)).filter((k) => k >= 0);
  const ours = sections.filter((_, k) => !last.includes(k)), after = last.map((k) => sections[k]);
  githubHeader();
  list.innerHTML = (lately.length ? `<section class="pgroup recent"><h3>Recent</h3>${grid(lately.join(""))}</section>` : "") + githubSection(places) + ours.join("") + after.join("") + examplesSection(places);
  find();
  showPictures(list);
  // Nothing of GitHub has been waited for. What the App is on, the first time since the page was loaded, and then what each has.
  if (auth.signedIn() && !storage.reachableAsked) {
    readGithub(mine);
    await lookForRepositories();
    if (mine !== drawing) return;
    drawGithub();
  }
  await readGithub(mine);
}

/** Only the projects whose name or path has what is typed in the search (and Recent, and folders with none of them,
 *  not at all; what a place offers, while searching, neither). */
function find() {
  const q = $("projectsFind").value.trim().toLowerCase(), list = $("projectsList");
  for (const a of list.querySelectorAll(".ptile[data-path]")) a.hidden = !!q && !a.dataset.find.includes(q);
  for (const a of list.querySelectorAll(".pact, .pnone-here")) a.hidden = !!q;
  for (const h of list.querySelectorAll("h4")) h.hidden = !!q && !h.nextElementSibling.querySelector(".ptile[data-path]:not([hidden])");
  for (const g of list.querySelectorAll(".pgroup")) g.hidden = !!q && (g.classList.contains("recent") || !g.querySelector(".ptile[data-path]:not([hidden])"));
  // (While searching, every place is unfolded: what is found is seen. Then each is as it was left.)
  const shut = folded();
  for (const d of list.querySelectorAll("details.pplace")) d.open = !!q || !shut.has(d.dataset.place);
}

/** Tiles, or a list: as the viewer last chose. */
function showView() {
  const view = stored("fettled.projects.view", "tiles");
  $("projectsList").classList.toggle("aslist", view === "list");
  for (const b of $("projectsView").querySelectorAll("button")) b.classList.toggle("on", b.dataset.view === view);
}

/** Goes to a project (by its model's id, in a place), or puts the page away where it is the one the page is of. */
async function go(path, kind, tile) {
  if (path === project.ofPage() && kind === storage.kind) return hideProjects();
  if (!leaving()) return;
  tile?.classList.add("going");
  await project.go(path, kind);
}

/** What a tile that is not a project does, by its `data-act`. */
async function act(what, tile) {
  try {
    if (what.startsWith("new:")) {
      const kind = what.slice(4), name = prompt("Name for the new workspace:");
      if (!name || !leaving()) return;
      const r = await project.createWorkspace(name, kind);
      if (r.error) return say(`The workspace was not made: ${r.error}`, true);
      return go(r.file, kind, tile);
    }
    if (what.startsWith("model:")) {
      const kind = what.slice(6), workspace = storage.workspaceIn(kind);
      if (!workspace) return say("That cannot be read yet: try again in a moment.", true);
      const name = prompt(`Name for the new model (a folder of its own in ${workspace}):`);
      if (!name || !leaving()) return;
      const r = await project.createModel(name, workspace, kind);
      if (r.error) return say(`The model was not made: ${r.error}`, true);
      return go(r.file, kind, tile);
    }
    if (what === "folder") {
      await storage.pickFolder();
      say(`${storage.folder.label} is open here: it is listed below.`, false);
      return renderProjects();
    }
    if (what === "letin") {
      if (!(await storage.letFolderIn())) return say(`${storage.folder.label} was not let in: this browser was not given leave to use it.`, true);
      // (The part asked for, that it was in: gone to now.)
      if (waiting?.kind === "folder") return go(waiting.entry, "folder", tile);
      say(`${storage.folder.label} is let in again.`, false);
      return renderProjects();
    }
    if (what === "signin") return auth.signIn();
    if (what === "signout") {
      // (Nothing is lost by it: edits kept here stay. Only unsaved script edits are asked about.)
      if (!leaving()) return;
      await auth.signOut();
      return location.reload();
    }
    if (what === "refresh") {
      tile?.classList.add("turning");
      // (Asked for, on a page with nothing open from there: each that has no changes kept here is brought up to date.)
      await lookForRepositories();
      await Promise.all(storage.githubKinds().map((k) => storage.of(k).fastForward().catch(() => {})));
      return renderProjects();
    }
    if (what === "unhide") {
      await storage.unhideBranches();
      return renderProjects();
    }
    if (what === "github") {
      $("githubTokenRow").hidden = $("githubTokenSay").hidden = auth.signedIn();
      $("githubTokenKept").textContent = sharedOrigin() ? "This site's address is shared with others, so it is kept only for this tab." : "It is kept in this browser.";
      showTokenLink();
      return $("githubFollow").showModal();
    }
    if (what.startsWith("unfollow:")) {
      await storage.unfollowBranch(what.slice(9));
      return renderProjects();
    }
    if (what === "host") {
      const at = prompt("The address of a fettled host (where fettled serve is running):", stored("fettled.host", "http://127.0.0.1:8765/"));
      if (!at || !leaving()) return;
      const u = new URL(/^https?:\/\//.test(at) ? at : `http://${at}`);
      store("fettled.host", u.origin + "/");
      return location.assign(u.origin + "/");
    }
  } catch (e) {
    // (A folder not picked, as asked: nothing is said.)
    if (e?.name !== "AbortError") say(`That did not work: ${e?.message ?? e}`, true);
  }
}

// A project clicked is gone to (with a modifier, or the middle button, the browser opens its link as it would); a tile
// that does something, does it.
$("projectsList").addEventListener("click", (e) => {
  const b = e.target.closest(".pact");
  if (b) { e.preventDefault(); return act(b.dataset.act, b); }
  const a = e.target.closest(".ptile[data-path]");
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(a.dataset.path, a.dataset.in, a);
});
// GitHub's sign-in, in the header.
$("projectsGithub").addEventListener("click", (e) => {
  const b = e.target.closest(".pact");
  if (b) { e.preventDefault(); act(b.dataset.act, b); }
});
// A place folded or unfolded by the viewer (not by searching) is kept so.
$("projectsList").addEventListener("toggle", (e) => {
  const d = e.target;
  if (!d.matches?.("details.pplace") || $("projectsFind").value.trim()) return;
  const shut = folded();
  if (d.open) shut.delete(d.dataset.place); else shut.add(d.dataset.place);
  store("fettled.projects.folded", [...shut]);
}, true);
/** The link to make a token, for the repository's owner as typed so far. */
const showTokenLink = () => {
  const owner = $("githubRepo").value.trim().split("/")[0];
  $("githubTokenLink").href = tokenLink(owner);
  $("githubTokenWrite").href = tokenLink(owner, "write");
};
$("githubRepo").addEventListener("input", showTokenLink);
// A branch to follow, as the dialog says it. (The token field is emptied either way: it is kept where it is put, not in the page.)
$("githubFollow").addEventListener("close", async () => {
  const d = $("githubFollow"), [repo, branch, token] = ["githubRepo", "githubBranch", "githubToken"].map((id) => $(id).value.trim());
  $("githubToken").value = "";
  if (d.returnValue !== "follow" || !repo) return;
  try {
    await storage.followBranch(repo, branch || "main", token);
    say("", false);
    await renderProjects();
  } catch (e) {
    say(`That did not work: ${e?.message ?? e}`, true);
  }
});
$("projectsFind").addEventListener("input", find);
// Enter: the first that is found; Escape: the page put away.
$("projectsFind").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const a = $("projectsList").querySelector(".ptile[data-path]:not([hidden])"); if (a) go(a.dataset.path, a.dataset.in, a); }
});
$("projectsView").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) { store("fettled.projects.view", b.dataset.view); showView(); }
});
$("projects").addEventListener("keydown", (e) => { if (e.key === "Escape") hideProjects(); });
$("projectsClose").onclick = hideProjects;
$("allProjects").onclick = () => showProjects();
