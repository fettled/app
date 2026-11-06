// A session (docs/collaboration.md): a room, what its log says, and who is in it. Everything that must arrive goes through the
// log, in the room's order. What is only true now (who is here, what they have open, which build of the app they are on) is told to
// each peer as it changes, and again to whoever arrives; it is kept nowhere. What is only for showing goes peer to peer (motion.js).
//
// What the log has, each `{ k, … }`:
//   open   { place, name, branch, entry, commit, host }   the first: what the session is of (`place`: the location; `name`: what it is
//          called; `host`: the host it is shared from, where it is shared over the internet)
//   ended  {}                                the host's person has stopped sharing it
//   hello  { who, name, picture, kind, of }  someone is taken part, or is called something else now (`kind` "agent": `of` whose)
//   edit   { file, over, gone | text | delta, build }   a file changed, from its version `over` (replica.js)
//   base   { commit }                        the files are now edits over this commit
//   say    { who, to, text }                 a message to someone
//   cannot { who, name, why }                someone invited cannot reach what the session is of
//
// A tool host there is asked by the room: `ask(call)` signals it `{ ask: { id, call, token? } }` (`call` as MCP's `tools/call` has it;
// or `{ ask: { id, method: "tools/list", token? } }`), and it answers `{ told: { id, part, of, text } }`, the text MCP's result, its
// images as links by their sha (fettled-room's pictures.rs), each asked for by `{ ask: { id, picture: SHA, token } }`. A host
// is one (crates/fettled-cli/src/share.rs); so is a page, for an agent it gave a card to where there is no host (`on.ask`).

//
// Nothing here knows of a page.

import { Room, newPictures } from "../room.js";
import { Replica } from "./replica.js";

/** The colours people are told apart by, in the order they first come: dark enough for white on them, far apart in hue. */
export const COLOURS = ["#e5484d", "#2f7fe8", "#2e9e5b", "#b45bd6", "#e8820c", "#0ea5a5", "#d6409f", "#7a6ff0"];

/** How long the host is waited for to be here, and to answer. */
const HOST_WITHIN = 15000, ANSWER_WITHIN = 30000;
/** How often what each has of the files is compared, while they change: everyone's merges are to come to the same. */
const COMPARE_EVERY = 5000;

export class Session {
  /**
   * `relay`, `id`, `secret`: the room (room.js). `me`: `{ who, name, picture }`. `read(commit, file)`: a file as a commit has it (null:
   * none). `sync`: fettled-sync, loaded (merge.js), by which the files are merged (replica.js). `on`: `open(entry)`; `changed(file, { own, dropped, live, built })`: a file's log moved on; `base(commit)`;
   * `people()`: who is here, or what they said of themselves, has changed; `diverged()`: which files are not the same as whose (`diverged`) has changed; `chat()`; `cannot({ who, name, why })`;
   * `refused(file, why)`: an edit of yours could not go; `signal(peer, value)`, `peers(list)`: for what goes peer to peer;
   * `caughtUp()`, `status(s)`, `gone()`: the relay has forgotten it.
   */
  constructor({ relay, id, secret, me, read, sync, on = {}, create = false }) {
    Object.assign(this, { me, read, on, id, secret });
    this.opened = null;
    this.replica = new Replica((file) => read(this.commit, file), sync, () => this.room.newId());
    /** The files whose text is not the same as someone else's here, at the same version: file → who. */
    this.diverged = new Map();
    this.participants = new Map();
    this.messages = [];
    /** Who is here now: relay's peer → what they last said of themselves. */
    this.here = new Map();
    this.mine = {};
    /** One edit made at a time: the file may have to be read first. */
    this.editing = Promise.resolve();
    /** What each edit waiting to be heard back from is of. */
    this.fileOfEdit = new Map();
    this.status = "connecting";
    this.unheard = [];
    /** What has been asked of the host, and what of each answer has come: id → `{ done, fail, parts, timer }`. */
    this.asked = new Map();
    this.caughtUpOnce = new Promise((done) => { this.caught = done; });
    this.room = new Room({ relay, id, secret, on: {
      entry: (e) => this.heard(e),
      peers: (list) => this.peersAre(list),
      signal: (from, value) => this.signalled(from, value),
      refused: (eid, why) => this.refused(eid, why),
      status: (s) => { this.status = s; this.on.status?.(s); },
      caughtUp: () => { this.caught(); this.on.caughtUp?.(); if (!create) this.greet(); },
      forgotten: () => this.on.gone?.(),
      unreadable: () => {},
    } });
  }
  /** The commit the files are over, at this place in the log (the replica's). */
  get commit() {
    return this.replica.commit;
  }
  /** This browser's own id for this connection. */
  get peer() { return this.room.peer; }

  // ----- the log --------------------------------------------------------------------------------------------------------

  async heard({ value: v, at, id }) {
    if (v.k === "open") {
      this.opened ??= v;
      await this.replica.entry(id, v);
      return this.on.open?.(v);
    }
    if (v.k === "hello") {
      const had = this.participants.get(v.who);
      this.participants.set(v.who, { ...had, id: v.who, name: v.name, picture: v.picture ?? null, kind: v.kind ?? "person", of: v.of ?? null, colour: had?.colour ?? COLOURS[this.participants.size % COLOURS.length], since: had?.since ?? at });
      return this.on.people?.();
    }
    if (v.k === "edit") {
      await this.replica.ensure(v.file);
      const was = { live: this.replica.live(v.file), built: this.replica.built(v.file) };
      const { own, dropped, next, mine, base } = await this.replica.entry(id, v);
      this.fileOfEdit.delete(id);
      if (next) this.sayEdit(next);
      this.compareSoon();
      return this.on.changed?.(v.file, { own, dropped, mine, base, live: this.replica.live(v.file), built: this.replica.built(v.file), liveWas: was.live, builtWas: was.built });
    }
    if (v.k === "base") {
      await this.replica.entry(id, v);
      return this.on.base?.(v.commit);
    }
    if (v.k === "say") {
      this.messages.push({ from: v.who, to: v.to, text: v.text, time: at });
      return this.on.chat?.();
    }
    if (v.k === "cannot") return this.on.cannot?.(v);
    if (v.k === "ended") {
      this.ended = true;
      return this.on.ended?.();
    }
  }
  refused(id, why) {
    const file = this.fileOfEdit.get(id);
    if (!file) return;
    this.fileOfEdit.delete(id);
    const { live, next } = this.replica.forget(id, file);
    if (next) this.sayEdit(next);
    this.on.refused?.(file, why, live);
  }

  /** Makes a file this text, seen at once, the log told. `build`: the model is to be built from it (not while it is typed). `base`:
   *  the text it was made from (Replica.edit). */
  edit(file, text, { build = true, base } = {}) {
    const r = (this.editing = this.editing.catch(() => {}).then(async () => {
      await this.replica.ensure(file);
      const e = this.replica.edit(file, text, { build, base });
      if (!e) return false;
      if (e.clash) {
        this.on.refused?.(file, "clash", this.replica.live(file), { mine: text, base });
        return false;
      }
      this.sayEdit(e);
      return true;
    }));
    return r;
  }
  sayEdit({ id, ...said }) {
    this.fileOfEdit.set(id, said.file);
    this.room.say({ k: "edit", ...said }, id);
  }
  /** Into the log as it is: `{ k, … }`. Its id. */
  say(value) {
    return this.room.say(value);
  }
  /** Whether everything said here has been heard back from. */
  get settled() {
    return this.replica.settled && this.room.waiting === 0;
  }

  // ----- who is here -----------------------------------------------------------------------------------------------------

  /** Said to the log, once: who this is, or what they are called now. */
  greet() {
    const known = this.participants.get(this.me.who);
    if (!known || known.name !== this.me.name || known.picture !== (this.me.picture ?? null)) this.say({ k: "hello", ...this.me });
    this.tellEveryone();
  }
  rename(name) {
    this.me = { ...this.me, name };
    this.greet();
  }
  /** Something of what is true of this person now, for those here. (A change at a time goes as one, at the end of the turn.) */
  present(patch) {
    Object.assign(this.mine, patch);
    if (this.telling) return;
    this.telling = true;
    queueMicrotask(() => { this.telling = false; this.tellEveryone(); });
  }
  tellEveryone() {
    for (const peer of this.here.keys()) this.tell(peer);
  }
  tell(peer) {
    this.room.signal(peer, { here: { who: this.me.who, ...this.mine } });
  }
  peersAre(list) {
    const now = new Set(list);
    for (const peer of this.here.keys()) if (!now.has(peer)) this.here.delete(peer);
    for (const peer of list) if (!this.here.has(peer)) { this.here.set(peer, {}); this.tell(peer); }
    this.on.peers?.(list);
    this.on.people?.();
  }
  signalled(from, value) {
    if (value.told) return this.toldByHost(value.told);
    if (value.ask) return this.answer(from, value.ask);
    if (value.here) {
      if (!this.here.has(from)) return;
      this.here.set(from, value.here);
      this.compare();
      return this.on.people?.();
    }
    // (Those that come before anyone is listening wait: a first offer lost is a connection never made.)
    if (this.on.signal) this.on.signal(from, value);
    else this.unheard.push([from, value]);
  }
  // ----- whether everyone's merges came to the same -------------------------------------------------------------------------

  /** Says what this person has of the files, a while after they last changed. */
  compareSoon() {
    this.comparing ??= setTimeout(() => { this.comparing = null; this.present({ sums: this.replica.sums() }); this.compare(); }, COMPARE_EVERY);
  }
  /** Of what those here say they have, the files whose text at the same version is not this person's, and whose it is not: told when that changes. */
  compare() {
    const now = new Map();
    for (const said of this.here.values()) {
      if (said.service || said.kind === "agent") continue;
      for (const file of this.replica.differs(said.sums)) now.set(file, [...(now.get(file) ?? []), said.who]);
    }
    const key = (m) => [...m].map(([file, who]) => `${file}:${[...who].sort()}`).sort().join("|");
    if (key(now) === key(this.diverged)) return;
    this.diverged = now;
    this.on.diverged?.();
  }

  // ----- the host, where it is shared over the internet (crates/fettled-cli/src/share.rs) --------------------------------------

  /** Those here who are people with a page, by their peers: what goes peer to peer is between them. (A host is here too, and is nobody;
   *  an agent is here through a host, and has no page.) */
  others() {
    return [...this.here].filter(([, said]) => !said.service && said.kind !== "agent").map(([peer]) => peer);
  }
  /** A tool call asked of the host, by the room (`{ name, arguments }`, as MCP's `tools/call`): its result, as MCP's (`{ content, isError
   *  }`). `token`: an agent's capability, to ask as that agent; without one, as someone invited may (the project's versions, to read). */
  async ask(call, { token } = {}) {
    let peer;
    for (const end = Date.now() + HOST_WITHIN; !(peer = this.peerOf("host"));) {
      if (Date.now() > end) throw new Error("the host this session is shared from is not connected: whoever shared it needs to have fettled serve running");
      await new Promise((r) => setTimeout(r, 50));
    }
    const id = this.room.newId();
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.asked.delete(id); fail(new Error("the host this session is shared from did not answer")); }, ANSWER_WITHIN);
      this.asked.set(id, { done, parts: [], timer });
      this.room.signal(peer, { ask: { id, call, ...(token ? { token } : {}) } });
    });
  }
  toldByHost({ id, part, of, text }) {
    const a = this.asked.get(id);
    if (!a) return;
    a.parts[part] = text;
    if (a.parts.filter((p) => p != null).length < of) return;
    this.asked.delete(id);
    clearTimeout(a.timer);
    a.done(JSON.parse(a.parts.join("")));
  }

  /** A tool call asked of this page by the room, as a tool host is asked one (`on.ask(from, ask)`: MCP's result), answered in parts to
   *  whoever asked. Of a page that answers none, nothing: another is asked (a host). */
  async answer(from, ask) {
    if (!this.on.ask) return;
    this.pictures ??= newPictures();
    let result;
    try {
      // (A picture of what it answered, for whoever asked for that; else what is asked, its pictures by their sha.)
      if (ask.picture) result = ask.token ? this.pictures.answer(ask.token, ask.picture) : { content: [{ type: "text", text: "error: a picture is for whoever asked for what it is of, by their token" }], isError: true };
      else {
        result = await this.on.ask(from, ask);
        if (ask.token) result = this.pictures.link(ask.token, result);
      }
    } catch (e) {
      result = { content: [{ type: "text", text: `error: ${e?.message ?? e}` }], isError: true };
    }
    for (const [part, of, text] of this.room.parts(JSON.stringify(result))) this.room.signal(from, { told: { id: ask.id, part, of, text } });
  }

  /** `f(peer, value)` for what peers send each other, from now on and what has come already. */
  listen(f) {
    this.on.signal = f;
    for (const [from, value] of this.unheard.splice(0)) f(from, value);
  }
  /** The peer of someone here (by who they are), or undefined. */
  peerOf(who) {
    for (const [peer, said] of this.here) if (said.who === who) return peer;
    return undefined;
  }

  /** Everyone who has taken part: `presence` "away", "here", or for an agent what it says it is doing ("waiting", "working"). */
  people() {
    const on = new Map([[this.me.who, "here"], ...[...this.here.values()].filter((s) => s.who).map((s) => [s.who, s.state ?? "here"])]);
    return [...this.participants.values()].map((p) => ({ ...p, presence: on.get(p.id) ?? "away" }));
  }

  close() {
    clearTimeout(this.comparing);
    this.room.close();
  }
}
