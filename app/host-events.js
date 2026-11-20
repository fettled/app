// What a fettled host tells a page as things change, on one stream. A browser makes six connections to a host and no more, shared by
// every tab open there, and a stream held open is one of them for as long as it is: a page that held two (its workspace's state,
// `api/events`, and its files changing, `files/events`) left room for three tabs, and the fourth waited for good to hear that its
// model was settled. So a page has one:
//
//   with a workspace listened to   `api/events`, which says its files changing too (`event: files`)
//   with none (a projects page)    `files/events`, of its files alone
//
// Whoever watches the files (`watchFiles`) and whoever listens to the workspace (`stateStream`) are each told by whichever is open.

/** Who is told the host's files changed: each `{ changed, failed }`. */
const watchers = new Set();
/** The stream of the files alone (`files/events` of `base`), open only while files are watched and no workspace is listened to. */
let files = null, filesBase = null;
/** The workspace's stream, while one is listened to. */
let state = null;

const tellFiles = () => { for (const w of watchers) w.changed(); };

function openFiles() {
  if (files || state || !watchers.size || filesBase == null || typeof EventSource === "undefined") return;
  const es = (files = new EventSource(filesBase + "events"));
  es.onmessage = tellFiles;
  // (A host that has no such stream, a static site: each watcher looks for itself instead.)
  es.onerror = () => { if (es.readyState === EventSource.CLOSED && files === es) { files = null; for (const w of [...watchers]) w.failed?.(); } };
}
const closeFiles = () => { files?.close(); files = null; };

/** The host's files (kept at `base`, `files/`) watched: `changed()` each time they may have changed; `failed()` where the host has no
 *  stream of that. Answers what stops it; null where a page has no streams. */
export function watchFiles(base, changed, failed) {
  if (typeof EventSource === "undefined") return null;
  const w = { changed, failed };
  watchers.add(w);
  filesBase = base;
  openFiles();
  return () => { watchers.delete(w); if (!watchers.size) closeFiles(); };
}

/** The host's stream of a workspace (`url`: `api/events?…`), opened: `said(data)` each state it says, `lost()` where it is lost (it is
 *  opened again by the browser). The files' own stream is let go of while this one is open, which says what that said. Answers what
 *  closes it (the files, if still watched, are then watched by their own stream again). */
export function stateStream(url, said, lost) {
  const es = new EventSource(url);
  state = es;
  closeFiles();
  let wasLost = false;
  es.addEventListener("state", (e) => said(e.data));
  es.addEventListener("files", tellFiles);
  // (Lost and had again: what changed meanwhile was not said, so the files are looked at.)
  es.onopen = () => { if (wasLost) { wasLost = false; tellFiles(); } };
  es.onerror = () => { wasLost = true; lost(); };
  return () => {
    es.close();
    if (state === es) { state = null; openFiles(); }
  };
}
