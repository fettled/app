// What the app keeps of a model for itself: its settles (`settles/KEY.json`, the engine's `fettled_script::part::settle_id`) and its
// sheets as drawn (`settles/KEY.drawn.json`), each by the key of what it is of (the files, the engine, the points read), never by where
// the model is, so that nobody's is put in place of another's; and of a scan, its layout and its confidence. Made again by whoever needs
// them, so none of a project: not among its files, in its changes, or in a session. Where it is kept is the app's concern:
//
//   on a host    `cache/ID`, in the repository's git folder (crates/fettled-script/src/part.rs, `settles_dir`, `cache_file`), where the
//                page and the host's own engine both find it, so that a model settled by either is not settled again by the other
//   a site       what it was published with, as well as:
//   elsewhere    this browser (IndexedDB)
//
// Nothing here fails: what is not kept is made again.

const DB = "fettled-cache", STORE = "cache";
let db = null;
const opened = () => (db ??= new Promise((done, fail) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => done(r.result);
  r.onerror = () => fail(r.error);
}));
const ask = async (mode, f) => {
  const d = await opened();
  return new Promise((done, fail) => {
    const t = d.transaction(STORE, mode), r = f(t.objectStore(STORE));
    t.oncomplete = () => done(r?.result);
    t.onerror = t.onabort = () => fail(t.error);
  });
};
/** Whether an id is of a settle or its sheets, by its key (`settles/KEY.json`, `settles/KEY.drawn.json`). */
const keyed = (id) => /(^|:)settles\/[0-9a-f]{32}(\.drawn)?\.json$/.test(id);
const url = (id) => `cache/${id.split("/").map(encodeURIComponent).join("/")}`;
const text = (r) => (r.ok ? r.text() : null);

/** The app's cache, for where the project of the page is kept (`storage`, project.js): `{ get(id): its text or null, set(id, text or
 *  bytes), forget(id): it is no longer kept (made again by whoever needs it), bytes(id): it as a worker reads its byte ranges (`{ url }` or `{ file }`, ranges.js) or null }`: what is kept of a point cloud
 *  (its layout, its confidence) is read in part. */
export function cacheOf(storage) {
  const site = storage.kind === "host" ? storage.site : null, place = storage.store?.label ?? storage.kind;
  if (site?.writable) {
    // (What the host says it has kept, as it last listed its files: what it has not is not asked for. Of settles, which it does not
    // list (there are as many as there have been settles), each is asked for by its key.)
    const listed = () => site.manifest?.cached;
    return {
      get: (id) => (listed() && !keyed(id) && !listed().includes(id) ? Promise.resolve(null) : fetch(url(id), { cache: "no-store" }).then(text).catch(() => null)),
      bytes: async (id) => (listed()?.includes(id) ? { url: new URL(url(id), location.href).href } : null),
      set: (id, body) => { if (listed() && !keyed(id) && !listed().includes(id)) listed().push(id); return fetch(url(id), { method: "PUT", body }).catch(() => {}); },
      forget: (id) => { const l = listed(); if (l?.includes(id)) l.splice(l.indexOf(id), 1); return fetch(url(id), { method: "DELETE" }).catch(() => {}); },
    };
  }
  return {
    async get(id) {
      const here = await ask("readonly", (s) => s.get(`${place}\n${id}`)).catch(() => null);
      if (here != null) return here;
      return site?.manifest?.cached?.includes(id) || (site && keyed(id)) ? fetch(url(id)).then(text).catch(() => null) : null;
    },
    set: (id, body) => ask("readwrite", (s) => s.put(body, `${place}\n${id}`)).catch(() => {}),
    forget: (id) => ask("readwrite", (s) => s.delete(`${place}\n${id}`)).catch(() => {}),
    async bytes(id) {
      const here = await ask("readonly", (s) => s.get(`${place}\n${id}`)).catch(() => null);
      if (here != null && typeof here !== "string") return { file: new Blob([here]) };
      return site?.manifest?.cached?.includes(id) ? { url: new URL(url(id), location.href).href } : null;
    },
  };
}
