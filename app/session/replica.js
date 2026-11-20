// A session's files, as this person has them (docs/collaboration.md, "One ordered log"): fettled-sync's replica
// (crates/fettled-sync/src/replica.rs, which says how), as a host has it too. What is here is what it cannot do itself: read a file's
// text at the commit the session began on, the first time it is asked of, and give ids to the edits it makes.

export class Replica {
  /** `origin(file)`: the text a file has at the commit the files are over (null: none), read once of each, before an entry or an edit of
   *  it is handled (`ensure`). `sync`: fettled-sync, loaded (merge.js). `newId()`: for an edit. */
  constructor(origin, sync, newId) {
    Object.assign(this, { origin, sync, newId });
    this.files = new sync.SessionFiles();
  }
  /** The commit the files are over, at this place in the log. */
  get commit() {
    return this.files.commit ?? null;
  }
  /** An entry of the log that is of the files (`open`, `base`, `edit`), by its id, in its order, the file it needs read first: what an
   *  edit did, as `heard` says it; null for anything else. */
  async entry(id, value) {
    const file = this.files.needs(JSON.stringify(value));
    if (file) this.load(file, await this.origin(file));
    const h = JSON.parse(this.files.entry(id, JSON.stringify(value), this.newId()));
    if (!h) return null;
    const { applied, own, dropped, next, ...back } = h;
    return { applied, own, dropped, next: next ?? undefined, ...back };
  }
  has(file) {
    return this.files.has(file);
  }
  /** A file's text as the commit has it, known from here on. */
  load(file, text) {
    this.files.load(file, text);
  }
  async ensure(file) {
    if (!this.has(file)) this.load(file, await this.origin(file));
  }
  /** The file as the log so far has it. */
  confirmed(file) {
    return this.files.confirmed(file) ?? null;
  }
  /** A file as this person sees it. */
  live(file) {
    return this.files.live(file) ?? null;
  }
  /** What the model is built from. */
  built(file) {
    return this.files.built(file) ?? null;
  }
  /** Whether nothing of this person's is waiting for the log. */
  get settled() {
    return this.files.settled;
  }
  /** The files any edit has touched. */
  get touched() {
    return JSON.parse(this.files.touched());
  }
  /** Three ways, as the replica merges: the text, or undefined where they clash. */
  merge(file, base, ours, theirs) {
    return this.sync.merge_file(file, base ?? "", ours, theirs);
  }

  /** Makes the file this text, as this person's edit: the entry to say now, or null (there is nothing to say, or it waits for the last).
   *  `build`: the model is to be built from it. `base`: the text it was made from, where that may not be the file as it now is. `{ clash:
   *  true }`: that clashes with what has come. */
  edit(file, asked, { build = true, base } = {}) {
    return JSON.parse(this.files.edit(file, asked, build, base !== undefined, base ?? null, this.newId()));
  }
  /** An edit of the log's, in its order: `{ applied, own, dropped, next, mine?, base? }`. */
  heard(entry) {
    const { applied, own, dropped, next, ...back } = JSON.parse(this.files.heard(JSON.stringify(entry), this.newId()));
    return { applied, own, dropped, next: next ?? undefined, ...back };
  }
  /** An edit of this person's that the log will not have: `{ next, live }`. */
  forget(id, file) {
    const { next, live } = JSON.parse(this.files.forget(id, file, this.newId()));
    return { next: next ?? undefined, live: live ?? null };
  }
  /** What this person has of each file touched, for others to compare: `{ file: [version, its sum] }`. */
  sums() {
    return JSON.parse(this.files.sums());
  }
  /** Of what someone else says they have, the files where the same version is not the same text here. */
  differs(theirs) {
    return JSON.parse(this.files.differs(JSON.stringify(theirs ?? {})));
  }
}
