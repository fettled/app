// What the app keeps of a model for itself: how it was last settled (`a.solved.json`) and its sheets as last drawn (`a.drawn.json`), each
// of a part script, by that script. Made again by whoever needs them, so none of a project: not among its files, in its changes, or in a
// session. Where it is kept is the app's concern:
//
//   on a host    `cache/ID`, in the repository's git folder (crates/fettled-script/src/part.rs, `cache_file`), where the page and the host's
//                own engine both find it, so that a model settled by either is not settled again by the other
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
const url = (id) => `cache/${id.split("/").map(encodeURIComponent).join("/")}`;
const text = (r) => (r.ok ? r.text() : null);

/** The app's cache, for where the project of the page is kept (`storage`, project.js): `{ get(id): its text or null, set(id, text or
 *  bytes), bytes(id): it as a worker reads its byte ranges (`{ url }` or `{ file }`, ranges.js) or null }`: what is kept of a scan
 *  (its layout, its confidence) is read in part. */
export function cacheOf(storage) {
  const site = storage.kind === "host" ? storage.site : null, place = storage.store?.label ?? storage.kind;
  if (site?.writable) {
    // (What the host says it has kept, as it last listed its files: what it has not is not asked for.)
    const listed = () => site.manifest?.cached;
    return {
      get: (id) => (listed() && !listed().includes(id) ? Promise.resolve(null) : fetch(url(id), { cache: "no-store" }).then(text).catch(() => null)),
      bytes: async (id) => (listed()?.includes(id) ? { url: new URL(url(id), location.href).href } : null),
      set: (id, body) => { if (listed() && !listed().includes(id)) listed().push(id); return fetch(url(id), { method: "PUT", body }).catch(() => {}); },
    };
  }
  return {
    async get(id) {
      const here = await ask("readonly", (s) => s.get(`${place}\n${id}`)).catch(() => null);
      if (here != null) return here;
      return site?.manifest?.cached?.includes(id) ? fetch(url(id)).then(text).catch(() => null) : null;
    },
    set: (id, body) => ask("readwrite", (s) => s.put(body, `${place}\n${id}`)).catch(() => {}),
    async bytes(id) {
      const here = await ask("readonly", (s) => s.get(`${place}\n${id}`)).catch(() => null);
      if (here != null && typeof here !== "string") return { file: new Blob([here]) };
      return site?.manifest?.cached?.includes(id) ? { url: new URL(url(id), location.href).href } : null;
    },
  };
}
