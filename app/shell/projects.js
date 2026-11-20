// The workspaces page: every workspace in every place they are kept, as a hierarchy that starts folded:
//   a source (this browser's storage, a folder on this computer, a host, GitHub, the built-in ones), each a section;
//     its workspaces (docs/workspaces.md: a folder with history), each a row, opened by its name;
//       a workspace's root parts, as tiles, each as it looked when it was last built (previews.js);
//     and, where the source makes them, a new workspace (or one added: a folder picked, a repository on GitHub).
// Above them, the root parts opened last, each said by where it is (source › workspace), each piece of that a way to it.
// Nothing here makes a part: a part is a script, made in its workspace's tree.
// A source that cannot be used now says why and offers the one thing that would let it (sign in, let a folder in again,
// go to a host). What is unfolded is kept as the viewer left it; while searching, all that is found is unfolded.
// One clicked is gone to (the page is loaded again with it: project.go); each is a link to it, so one can be opened in a
// tab of its own. Shown over the page when asked for (the project's name in the header, the menu), and where the page is
// of no project (its address names none, or one that could not be opened: why, said).

import { idOf, pathIn, workspaceOf } from "../ids.js";
import { $, esc, store, stored } from "../ui.js";
import { EXAMPLES_KIND, isBuiltin, project, storage } from "../project.js";
import { copyWorkspace } from "./copy.js";
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

/** The pictures shown, as URLs: let go of when the page is put away. */
let pictures = [];
const letGo = () => { for (const u of pictures) URL.revokeObjectURL(u); pictures = []; pictureOf.clear(); };
/** The same, by the root part each is of (`kind\npath`): a drawing again shows them at once. */
const pictureOf = new Map();
/** A project asked for that could not be opened from where it is (`{ entry, kind }`): gone to once it can be. */
let waiting = null;
/** The root parts opened last (`project.recent`), as last read. */
let recent = [];
/** What each place was found to have (`{ projects }` or `{ error }`), by kind; not there: not read yet. */
const listing = new Map();
/** The places being read now. */
const reading = new Set();
/** Of each built-in place, the files this browser kept edited over it from before it was read-only (by kind). */
const held = new Map();

/**
 * Shows the workspaces page, the search ready to type into. `said`: why it is shown (a project not opened); `asked`:
 * that project, where it can be opened once its place can be used (a folder let in again).
 */
export async function showProjects(said, asked = null) {
  $("menu").hidden = true;
  $("projects").hidden = false;
  say(typeof said === "string" ? said : "", true);
  waiting = asked;
  // (Not put away where the page is of no project: there is nothing under it.)
  $("projectsClose").hidden = !project.ofPage();
  $("projectsAccount").hidden = false;
  $("projectsFind").value = "";
  $("projectsFind").focus();
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
/** What is shown of a part with no picture yet: the first letters of its name. */
const initials = (name) => name.split(/[^A-Za-z]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "·";
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// ----- what there is ----------------------------------------------------------------------------------------------

/** Whether the host is the site's own files, read-only (the examples a published page comes with): a built-in place. */
const readOnlySite = () => !!storage.site && !storage.site.writable;

/**
 * The sources, in order: `{ id, label, note, places, head, add }`. `places`: where its workspaces are, each `{ kind,
 * label, one, needs, unfollow }` (`one`: the place is one workspace, listed before it is read, read when unfolded; `needs`:
 * what would let it be used, where it cannot be now). `head`: the one thing its header offers; `add`: its last row, a
 * workspace made or added (none where it is read-only).
 */
function sources() {
  const out = [];
  out.push({ id: "browser", label: "Browser storage", note: "Kept in this browser, on this computer", places: [{ kind: "browser" }], add: ["new:browser", "New workspace…"] });
  if (storage.locations().some((l) => l.kind === "folder")) {
    const f = storage.folder;
    out.push({
      id: "folder", label: "Local folder", note: f ? "A folder on this computer, read and written by this browser" : "Open a folder on this computer as a workspace",
      places: f ? [{ kind: "folder", label: f.label, needs: storage.folderLet ? null : "letin" }] : [],
      add: ["folder", f ? "Open another folder…" : "Open a folder…"],
    });
  }
  // (Hosts: a source each. The one serving the page, for now; where it serves only its own files, read-only, they are built-in.)
  for (const h of hosts()) out.push(h);
  const signedIn = auth.signedIn();
  out.push({
    id: "github", label: "GitHub",
    note: signedIn ? `Signed in as ${auth.login()}` : auth.can() ? "Sign in to reach your repositories, or add a public one by its name" : "Add a repository by its name",
    places: storage.githubKinds().map((kind) => ({ kind, label: storage.of(kind)?.base?.label ?? kind, one: true, unfollow: true })),
    head: !signedIn && auth.can() ? ["signin", "Sign in with GitHub", "gsignin"] : storage.githubKinds().length ? ["refresh", "⟳", "", "Bring up to date each repository here that has no changes kept here"] : null,
    add: ["github", signedIn ? "Add a repository…" : "Add a public repository…"],
  });
  const builtin = [{ kind: EXAMPLES_KIND, label: "Examples", one: true, link: `https://github.com/${EXAMPLES.repo}` }];
  if (readOnlySite()) builtin.push({ kind: "host", label: storage.site.label });
  out.push({ id: "builtin", label: "Built-in", note: "Read-only: copy one to a place of your own to change it", places: builtin.map((p) => ({ ...p, copy: true })) });
  return out;
}
/** The hosts listed: each a source. (Only the one serving the page, now; or, where none does, a way to go to one.) */
function hosts() {
  if (storage.site && !readOnlySite()) {
    return [{ id: "host", label: "Host server", note: `${storage.site.label} · ${location.host}`, places: [{ kind: "host" }], add: project.makesWorkspaces("host") ? ["new:host", "New workspace…"] : null }];
  }
  return [{ id: "host", label: "Host server", note: "Not connected: this page is not served by fettled serve", places: [], head: ["host", "Connect to a host…"] }];
}

/** The source a place is in (its id). */
const sourceOf = (kind) => kind === EXAMPLES_KIND || (kind === "host" && readOnlySite()) ? "builtin" : kind.startsWith("github:") ? "github" : kind;
/** The key a workspace's row is kept by: the place, where it is one workspace; else the place and the workspace's name. */
const keyOf = (place, workspace) => (place.one || place.needs ? place.kind : `${place.kind}\n${workspace}`);
/** The same, of a part opened (`{ in, path }`). */
const keyOfPart = (kind, path) => {
  const place = sources().flatMap((s) => s.places).find((p) => p.kind === kind);
  return place ? keyOf(place, workspaceOf(path)) : `${kind}\n${workspaceOf(path)}`;
};

/**
 * A source's workspaces: `{ key, kind, name, label, parts, error, needs, unfollow, link }` (`parts`: null where it has not
 * been read).
 */
function workspacesOf(src) {
  const out = [];
  for (const place of src.places) {
    const said = listing.get(place.kind), base = { kind: place.kind, unfollow: place.unfollow, link: place.link, copy: place.copy };
    if (place.needs) { out.push({ ...base, key: keyOf(place), label: place.label, parts: [], needs: place.needs }); continue; }
    if (place.one || said?.error) {
      // (A repository that could not be read, where no one is signed in: likely a private one, which signing in would let in.)
      const needs = said?.error && !auth.signedIn() && auth.can() && place.kind.startsWith("github:") ? "signin" : null;
      out.push({ ...base, key: keyOf(place), name: said?.projects?.[0]?.workspace, label: place.label ?? place.kind, parts: said?.projects ?? (said ? [] : null), error: said?.error, needs });
      continue;
    }
    if (!said) { out.push({ ...base, key: keyOf(place, ""), label: "Reading…", parts: null }); continue; }
    const by = new Map();
    for (const p of said.projects) (by.get(p.workspace) ?? by.set(p.workspace, []).get(p.workspace)).push(p);
    for (const [name, parts] of [...by].sort(([a], [b]) => a.localeCompare(b))) out.push({ ...base, key: keyOf(place, name), name, label: name, parts });
  }
  return out;
}

/** What a workspace opens as, where it says: its own model; else the part of it opened last; else its one part. */
function targetOf(w) {
  if (!w.parts?.length) return null;
  const own = w.parts.find((p) => p.path === idOf(p.workspace, "model.ts"));
  if (own) return own.path;
  const last = recent.find((r) => r.in === w.kind && w.parts.some((p) => p.path === r.path));
  return last?.path ?? (w.parts.length === 1 ? w.parts[0].path : null);
}

// ----- drawn --------------------------------------------------------------------------------------------------------

/** What is unfolded (`src:ID`, `ws:KEY`), as the viewer left it: everything starts folded. */
const unfolded = () => new Set(stored("fettled.workspaces.open", []));
const keepUnfolded = (set) => store("fettled.workspaces.open", [...set]);

/** A small button (`act`: what, as the click handler knows it). */
const small = (act, text, title = "", cls = "") => `<button class="pact pbtn ${cls}" data-act="${esc(act)}" title="${esc(title || text)}">${esc(text)}</button>`;
/** A part's picture, filled in when it is had. */
const shot = (path, kind, name) => `<span class="pshot" data-path="${esc(path)}" data-in="${esc(kind)}"><span class="pnone">${esc(initials(name))}</span></span>`;
/** Whether a part is the one the page is of. */
const isOpen = (path, kind) => path === project.ofPage() && kind === storage.kind;

/** A root part's tile (`crumbs`: where it is, in Recent). */
function tile(p, kind, crumbs = "") {
  const open = isOpen(p.path, kind), where = p.group ? `${p.group}/` : "";
  const meta = crumbs || [where && `in ${where}`, p.changed && `changed ${ago(p.changed)}`].filter(Boolean).join(" · ");
  return `<div class="ptile${open ? " open" : ""}${crumbs ? " precent" : ""}" data-find="${esc(`${p.name} ${p.path}`.toLowerCase())}">
    <a class="pgo" href="${esc(project.href(p.path, kind))}" data-path="${esc(p.path)}" data-in="${esc(kind)}" title="${esc(p.path)}${open ? " (open)" : ""}">${shot(p.path, kind, p.name)}
    <span class="pname">${esc(p.name)}${open ? ` <span class="popen">open</span>` : ""}</span></a>
    <span class="pmeta">${crumbs ? meta : esc(meta)}</span>
  </div>`;
}
const grid = (tiles) => `<div class="pgrid">${tiles}</div>`;

/** A workspace's row, and its parts under it. */
function workspaceRow(w, open) {
  const target = targetOf(w), latest = Math.max(0, ...(w.parts ?? []).map((p) => p.changed));
  const edits = (held.get(w.kind) ?? []).filter((id) => !w.name || workspaceOf(id) === w.name).length, ws = w.name ?? "";
  const meta = w.needs === "letin" ? "this browser needs your leave to use it again"
    : w.needs === "signin" ? "sign in to read it"
    : w.error ? "could not be read"
    : !w.parts ? (w.label === "Reading…" ? "" : "not read yet")
    : [plural(w.parts.length, "part"), latest && `changed ${ago(latest)}`].filter(Boolean).join(" · ");
  const name = target ? `<a class="pgo pwsname" href="${esc(project.href(target, w.kind))}" data-path="${esc(target)}" data-in="${esc(w.kind)}" title="Open ${esc(w.label)}">${esc(w.label)}</a>` : `<span class="pwsname">${esc(w.label)}</span>`;
  const acts = [
    w.needs === "letin" && small("letin", "Allow again", "The browser asks once for leave to use this folder"),
    w.needs === "signin" && small("signin", "Sign in with GitHub", "Goes to GitHub, and comes back here", "gsignin"),
    w.copy && edits && `<span class="pheld" title="Edited here before it was read-only: copied with it, or let go of">${plural(edits, "file")} edited here</span>`,
    w.copy && edits && small(`discard:${w.kind}\n${ws}`, "Discard", "Let go of the files edited here: it is then as it is built-in"),
    w.copy && small(`copy:${w.kind}\n${ws}${edits ? `\n${edits}` : ""}`, edits ? "Save as a copy…" : "Copy to…", "A workspace of your own, with all of this one's scripts and data, to change"),
    w.link && `<a class="pbtn" target="_blank" rel="noopener noreferrer" href="${esc(w.link)}" title="Where they are kept">On GitHub</a>`,
    w.unfollow && small(`unfollow:${w.kind}`, "×", `No longer list ${w.label} here (edits kept here stay)`, "pquiet"),
  ].filter(Boolean).join("");
  const body = w.needs ? "" : w.error ? `<p class="muted pnone-here">${esc(w.error)}</p>`
    : !w.parts ? `<p class="muted pnone-here">Reading…</p>`
    : !w.parts.length ? `<p class="muted pnone-here">No root parts here yet: make one in its tree (right-click a folder, New file…).</p>`
    : grid(w.parts.map((p) => tile(p, w.kind)).join(""));
  return `<details class="pws" data-key="ws:${esc(w.key)}" data-in="${esc(w.kind)}" data-find="${esc(w.label.toLowerCase())}"${open ? " open" : ""}>
    <summary class="pwsrow">${target ? shot(target, w.kind, w.label) : `<span class="pshot"><span class="pnone">${esc(initials(w.label))}</span></span>`}
      <span class="pwstext">${name}<span class="pmeta">${esc(meta)}</span></span><span class="pwsacts">${acts}</span></summary>
    <div class="pwsbody">${body}</div>
  </details>`;
}

/** A source's section. */
function sourceSection(src, open) {
  const ws = workspacesOf(src), shut = unfolded();
  const head = src.head ? small(src.head[0], src.head[1], src.head[3], src.head[2]) : "";
  const count = ws.filter((w) => w.label !== "Reading…").length;
  const add = src.add ? `<button class="pact paddrow" data-act="${esc(src.add[0])}"><span class="pplus">+</span>${esc(src.add[1])}</button>` : "";
  const none = !ws.length && !add && !head ? `<p class="muted pnone-here">None here.</p>` : "";
  return `<details class="psrc" data-key="src:${src.id}"${open ? " open" : ""}>
    <summary class="psrcrow"><span class="psrctext"><h3>${esc(src.label)}${count ? ` <span class="pcount">${count}</span>` : ""}</h3><span class="pnote">${esc(src.note ?? "")}</span></span><span class="pwsacts">${head}</span></summary>
    <div class="psrcbody">${ws.map((w) => workspaceRow(w, shut.has(`ws:${w.key}`))).join("")}${add}${none}</div>
  </details>`;
}

/** Recent: each part opened last, said by where it is, each piece of that a way to it on this page. */
function recentSection() {
  const all = sources();
  const rows = recent.map((r) => {
    const src = all.find((s) => s.id === sourceOf(r.in)), w = workspaceOf(r.path) ?? "";
    const p = listing.get(r.in)?.projects?.find((x) => x.path === r.path) ?? { name: nameOfPath(r.path), path: r.path, changed: 0 };
    const wlabel = src?.places.find((pl) => pl.kind === r.in && (pl.one || pl.needs))?.label ?? w;
    const crumbs = `<button class="pcrumb" data-reveal="src:${esc(src?.id ?? "")}" title="Show ${esc(src?.label ?? "")}">${esc(src?.label ?? r.in)}</button><span class="psep">›</span><button class="pcrumb" data-reveal="ws:${esc(keyOfPart(r.in, r.path))}" data-src="${esc(src?.id ?? "")}" title="Show ${esc(wlabel)}">${esc(wlabel)}</button>`;
    return tile(p, r.in, crumbs);
  });
  return rows.length ? `<section class="precents"><h3>Recent</h3>${grid(rows.join(""))}</section>` : "";
}

/** A model's name where its place has not been read: its folder's, for the model of a folder; its workspace's, for the workspace's own. */
const nameOfPath = (id) => { const parts = pathIn(id).replace(/\.ts$/, "").split("/"), last = parts.pop(); return last === "model" ? parts.pop() ?? workspaceOf(id) ?? last : last; };

/** Each part's picture, as it is had (not waited for: the tiles are there first). One had already is there at once. */
function showPictures(within) {
  for (const s of within.querySelectorAll(".pshot[data-path]")) {
    const key = `${s.dataset.in}\n${s.dataset.path}`, had = pictureOf.get(key), show = (url) => { s.innerHTML = `<img src="${url}" alt="">`; };
    if (had) { show(had); continue; }
    previewOf(s.dataset.path, s.dataset.in).then((url) => {
      if (!url) return;
      pictures.push(url);
      pictureOf.set(key, url);
      if (s.isConnected) show(url);
    });
  }
}

/** The page as it now stands. (Coalesced: places may come in together. Not on an animation frame: a page in a tab not
 *  in sight has none.) */
let drawn = false;
function draw() {
  if (drawn) return;
  drawn = true;
  queueMicrotask(() => {
    drawn = false;
    const list = $("projectsList"), shut = unfolded(), y = $("projects").scrollTop;
    list.innerHTML = recentSection() + sources().map((s) => sourceSection(s, shut.has(`src:${s.id}`))).join("");
    $("projects").scrollTop = y;
    find();
    showPictures(list);
    readUnfolded();
  });
}

/** Reads a place (once at a time), and draws the page again with it. The examples are brought up to date first (where
 *  nothing is kept here over them). */
async function read(kind) {
  if (reading.has(kind)) return;
  reading.add(kind);
  try {
    if (kind === EXAMPLES_KIND) await storage.of(kind)?.fastForward?.().catch(() => {});
    listing.set(kind, await project.listIn(kind));
  } finally {
    reading.delete(kind);
  }
  draw();
}
/** The places on GitHub whose workspace is unfolded and not read yet: read now. (Nothing on GitHub is read till it is looked at.) */
function readUnfolded() {
  for (const d of $("projectsList").querySelectorAll("details.pws[open]")) {
    const kind = d.dataset.in;
    if (!listing.has(kind) && !reading.has(kind) && storage.of(kind)) read(kind);
  }
}

/** The page, at once: every place on this computer read first (they are quick); GitHub's as each is unfolded. */
async function renderProjects() {
  const local = storage.locations().filter((l) => !l.kind.startsWith("github:"));
  for (const k of [...listing.keys()]) if (!k.startsWith("github:")) listing.delete(k);
  const [lists, r] = await Promise.all([Promise.all(local.map((l) => (l.store ? project.listIn(l.kind) : null))), project.recent()]);
  local.forEach((l, k) => { if (lists[k]) listing.set(l.kind, lists[k]); });
  recent = r;
  for (const kind of [EXAMPLES_KIND, "host"].filter(isBuiltin)) held.set(kind, (await storage.of(kind)?.edits?.().catch(() => [])) ?? []);
  letGo();
  draw();
}

/** Only the parts and workspaces whose name has what is typed in the search, all unfolded (and Recent, and what a
 *  source offers, not at all). Then each as the viewer left it. */
function find() {
  const q = $("projectsFind").value.trim().toLowerCase(), list = $("projectsList"), shut = unfolded();
  list.querySelector(".precents")?.toggleAttribute("hidden", !!q);
  for (const a of list.querySelectorAll(".psrc .ptile")) a.hidden = !!q && !a.dataset.find.includes(q);
  for (const a of list.querySelectorAll(".paddrow, .psrc .pnone-here")) a.hidden = !!q;
  for (const w of list.querySelectorAll("details.pws")) {
    const any = !!w.querySelector(".ptile:not([hidden])");
    w.hidden = !!q && !any && !w.dataset.find.includes(q);
    w.open = q ? any : shut.has(w.dataset.key);
  }
  for (const s of list.querySelectorAll("details.psrc")) {
    s.hidden = !!q && !s.querySelector("details.pws:not([hidden])");
    s.open = q ? !s.hidden : shut.has(s.dataset.key);
  }
}

/** Unfolds a source, or a workspace and its source, and brings it into sight (a piece of where a recent part is). */
function reveal(key, src) {
  const shut = unfolded();
  shut.add(key);
  if (src) shut.add(`src:${src}`);
  keepUnfolded(shut);
  if ($("projectsFind").value) { $("projectsFind").value = ""; }
  find();
  const at = [...$("projectsList").querySelectorAll("details")].find((d) => d.dataset.key === key);
  if (!at) return;
  readUnfolded();
  at.scrollIntoView({ block: "start", behavior: "smooth" });
  at.classList.remove("flash");
  void at.offsetWidth;
  at.classList.add("flash");
}

// ----- what is done -------------------------------------------------------------------------------------------------

/** Goes to a part (by its id, in a place), or puts the page away where it is the one the page is of. */
async function go(path, kind, el) {
  if (isOpen(path, kind)) return hideProjects();
  if (!leaving()) return;
  el?.closest(".ptile, .pws")?.classList.add("going");
  await project.go(path, kind);
}

/** What a button does, by its `data-act`. */
async function act(what, b) {
  try {
    if (what.startsWith("new:")) {
      const kind = what.slice(4), name = prompt("Name for the new workspace:");
      if (!name || !leaving()) return;
      const r = await project.createWorkspace(name, kind);
      if (r.error) return say(`The workspace was not made: ${r.error}`, true);
      return go(r.file, kind, b);
    }
    if (what === "folder") {
      await storage.pickFolder();
      say(`${storage.folder.label} is open here.`, false);
      const shut = unfolded();
      shut.add("src:folder");
      keepUnfolded(shut);
      return renderProjects();
    }
    if (what === "letin") {
      if (!(await storage.letFolderIn())) return say(`${storage.folder.label} was not let in: this browser was not given leave to use it.`, true);
      // (The part asked for, that it was in: gone to now.)
      if (waiting?.kind === "folder") return go(waiting.entry, "folder", b);
      say(`${storage.folder.label} is let in again.`, false);
      return renderProjects();
    }
    if (what === "signin") return auth.signIn();
    if (what === "refresh") {
      b?.classList.add("turning");
      // (Asked for, on a page with nothing open from there: each that has no changes kept here is brought up to date.)
      await Promise.all(storage.githubKinds().map((k) => storage.of(k).fastForward().catch(() => {})));
      for (const k of storage.githubKinds()) listing.delete(k);
      return draw();
    }
    if (what === "github") return openFollow();
    if (what.startsWith("copy:") || what.startsWith("discard:")) {
      const [verb, rest] = [what.slice(0, what.indexOf(":")), what.slice(what.indexOf(":") + 1)];
      const [kind, named, edits] = rest.split("\n");
      // (A place on GitHub not read yet: read, for the workspace it is.)
      if (!named && !listing.has(kind)) await read(kind);
      const workspace = named || listing.get(kind)?.projects?.[0]?.workspace;
      if (!workspace) return say("That cannot be read yet: try again in a moment.", true);
      if (verb === "copy") return copyWorkspace({ kind, workspace, part: recent.find((r) => r.in === kind && workspaceOf(r.path) === workspace)?.path, edits: +edits || 0 });
      if (!confirm(`Let go of the files edited here over ${workspace}? It is then as it is built-in.`)) return;
      const r = await project.discardEdits(kind, workspace);
      if (r.error) return say(`They were not let go of: ${r.error}`, true);
      return renderProjects();
    }
    if (what.startsWith("unfollow:")) {
      const kind = what.slice(9);
      await storage.unfollowBranch(kind);
      listing.delete(kind);
      return draw();
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
  } finally {
    b?.classList.remove("turning");
  }
}

$("projectsList").addEventListener("click", (e) => {
  const b = e.target.closest("button.pact");
  // (A button in a row's header does what it does, and does not fold or unfold the row.)
  if (b) { e.preventDefault(); return act(b.dataset.act, b); }
  const c = e.target.closest("button.pcrumb");
  if (c) { e.preventDefault(); return reveal(c.dataset.reveal, c.dataset.src); }
  // (A part clicked is gone to; with a modifier, or the middle button, the browser opens its link as it would.)
  const a = e.target.closest("a.pgo");
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(a.dataset.path, a.dataset.in, a);
});
// A source or workspace folded or unfolded by the viewer (not by searching) is kept so; a workspace on GitHub unfolded is read.
$("projectsList").addEventListener("toggle", (e) => {
  const d = e.target;
  if (!d.matches?.("details[data-key]") || $("projectsFind").value.trim()) return;
  const shut = unfolded();
  if (d.open) shut.add(d.dataset.key); else shut.delete(d.dataset.key);
  keepUnfolded(shut);
  if (d.open) readUnfolded();
}, true);

// ----- a repository on GitHub, added --------------------------------------------------------------------------------

/** The repositories the person signed in can reach, as last had (`null`: not asked since the page was loaded): what the
 *  dialog offers to pick from. */
let reachable = null;
/** How many times the dialog has been opened: what an earlier opening was reading is not shown by a later one. */
let picking = 0;
/** The dialog, asking which. */
function openFollow() {
  $("githubTokenRow").hidden = $("githubTokenSay").hidden = auth.signedIn();
  $("githubTokenKept").textContent = sharedOrigin() ? "This site's address is shared with others, so it is kept only for this tab." : "It is kept in this browser.";
  $("githubIntro").textContent = auth.signedIn() ? "One of yours, picked below (the one pushed to last first); or any you can read, by its name." : "Any repository you can read, by its name: public ones need nothing more.";
  $("githubRepo").value = $("githubBranch").value = "";
  showTokenLink();
  $("githubFollow").showModal();
  // (Signed in: what there is to pick from, read again each time it is asked for.)
  if (auth.signedIn()) readPick(); else showPick();
}
/** The dialog's list, as it now stands: those not listed here already whose name has what is typed. */
function showPick(why = "") {
  const at = $("githubPick"), q = $("githubRepo").value.trim().toLowerCase(), have = new Set(storage.githubKinds());
  const rows = (reachable ?? []).filter((r) => !have.has(`github:${r.full_name}@${r.default_branch}`) && r.full_name.toLowerCase().includes(q));
  at.hidden = !auth.signedIn();
  at.innerHTML = rows.map((r) => `<button type="button" class="gpickrow" data-repo="${esc(r.full_name)}" data-branch="${esc(r.default_branch)}" title="Add ${esc(r.full_name)}, at ${esc(r.default_branch)}"><b>${esc(r.full_name)}</b><span>${r.private ? "private · " : ""}${esc(r.default_branch)}</span></button>`).join("")
    || `<p class="muted">${esc(why || (!reachable ? "Reading your repositories…" : q ? "None of yours has that in its name: add it by its whole name, owner/name." : "No more of yours to add."))}</p>`;
}
/** Reads them again, the list shown as each of GitHub's pages is had. */
async function readPick() {
  const mine = ++picking;
  showPick();
  try {
    const all = [];
    for await (const page of storage.reachable()) {
      if (mine !== picking) return;
      all.push(...page);
      reachable = [...all];
      showPick();
    }
    reachable = all;
    showPick();
  } catch (e) {
    if (mine === picking) showPick(`GitHub would not say which repositories there are: ${e?.message ?? e}`);
  }
}
/** The link to make a token, for the repository's owner as typed so far. */
const showTokenLink = () => {
  const owner = $("githubRepo").value.trim().split("/")[0];
  $("githubTokenLink").href = tokenLink(owner);
  $("githubTokenWrite").href = tokenLink(owner, "write");
};
$("githubRepo").addEventListener("input", () => { showTokenLink(); showPick(); });
// One picked is added, at its default branch.
$("githubPick").addEventListener("click", (e) => {
  const b = e.target.closest(".gpickrow");
  if (!b) return;
  $("githubRepo").value = b.dataset.repo;
  $("githubBranch").value = b.dataset.branch;
  $("githubFollow").close("follow");
});
// A branch to follow, as the dialog says it: listed, and unfolded. (The token field is emptied either way: it is kept
// where it is put, not in the page.)
$("githubFollow").addEventListener("close", async () => {
  const d = $("githubFollow"), [repo, branch, token] = ["githubRepo", "githubBranch", "githubToken"].map((id) => $(id).value.trim());
  $("githubToken").value = "";
  if (d.returnValue !== "follow" || !repo) return;
  try {
    const before = new Set(storage.githubKinds());
    await storage.followBranch(repo, branch || "main", token);
    say("", false);
    const shut = unfolded();
    shut.add("src:github");
    for (const k of storage.githubKinds()) if (!before.has(k)) shut.add(`ws:${k}`);
    keepUnfolded(shut);
    draw();
  } catch (e) {
    say(`That did not work: ${e?.message ?? e}`, true);
  }
});

$("projectsFind").addEventListener("input", find);
// Enter: the first that is found; Escape: the page put away.
$("projectsFind").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const a = $("projectsList").querySelector(".psrc .ptile:not([hidden]) a.pgo"); if (a) go(a.dataset.path, a.dataset.in, a); }
});
$("projects").addEventListener("keydown", (e) => { if (e.key === "Escape") hideProjects(); });
$("projectsClose").onclick = hideProjects;
$("allProjects").onclick = () => showProjects();
