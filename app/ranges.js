// A file read by its byte ranges, in a worker (as a worker can, at once: a request that waits, or a file's slice): of a store's
// `{ url }` or `{ file }`. What fettled-ranges reads through, for a facet session's frames (session-worker.js) and a scan (worker.js).

/** `length` bytes from `offset` of a file: a `Uint8Array`. */
export function read(source, offset, length) {
  if (source.file) return new Uint8Array(new (/** @type {any} */ (globalThis).FileReaderSync)().readAsArrayBuffer(source.file.slice(offset, offset + length)));
  const r = new XMLHttpRequest();
  r.open("GET", source.url, false);
  r.responseType = "arraybuffer";
  r.setRequestHeader("Range", `bytes=${offset}-${offset + length - 1}`);
  r.send();
  if (r.status !== 206 && r.status !== 200) throw new Error(`${source.url}: ${r.status}`);
  return new Uint8Array(r.response);
}

/** How long a file is; null where it is not there. */
export function sizeOf(source) {
  if (!source) return null;
  if (source.file) return source.file.size;
  const r = new XMLHttpRequest();
  r.open("HEAD", source.url, false);
  r.send();
  return r.status === 200 ? Number(r.getResponseHeader("Content-Length")) : null;
}
