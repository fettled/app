// A room, as a page has it: what is said is sealed with a key whatever keeps the room never sees (it is in the fragment of the
// invite link, which a browser does not send), given in the room's order, and sent again after a connection goes, kept once.
// docs/collaboration.md says what a session is; session/session.js is its use.
//
// What keeps a room says the same things either way, and is reached by its address:
//
//   a relay   relay/src/relay.js: `wss://…`, by a WebSocket
//   a host    crates/fettled-cli/src/rooms.rs, a `fettled serve`: `http://…`, by a stream one way and requests the other

// Being a peer of it is fettled-room's (crates/fettled-room), as a host has it too: sealing, the log's order, what is sent again till
// the log has it, who is here. What is here is only the connection, which is the page's: a WebSocket, or a stream and requests.

let core = null;
/** fettled-room, loaded: before a room is made. `wasm`: its bytes, where there is no fetching them (Node). */
export async function loadRoom(wasm) {
  if (core) return core;
  const m = await import(new URL("../pkg/fettled_room.js", import.meta.url).href);
  if (wasm) m.initSync({ module: wasm });
  else await m.default();
  return (core = m);
}
const loaded = () => core ?? (() => { throw new Error("fettled-room is not loaded (loadRoom)"); })();

/** A new room: `{ id, secret }`, which an invite link carries as `#room=id.secret`. */
export function newRoom() {
  return JSON.parse(loaded().new_room());
}

/** An agent's capability in a room, as it begins (fettled-room's capability.rs: it may say and use the tools, and lands nothing till
 *  its person lets it): `{ token, room, who, name, kind, of, verbs }`. */
export function newCapability(room, who, name, of) {
  return JSON.parse(loaded().new_capability(room, who, name, of));
}

/** The pictures a tool host keeps of what it answered by the room (fettled-room's pictures.rs): `link(token, result)`, a result's images
 *  in place of themselves as links by their sha, kept for whoever asked; `answer(token, sha)`, one of them, as MCP's result. */
export function newPictures() {
  const p = new (loaded().RoomPictures)();
  return { link: (token, result) => JSON.parse(p.link(token, JSON.stringify(result))), answer: (token, sha) => JSON.parse(p.answer(token, sha)) };
}

/** A new person's key, by which what they say to their agent is signed. */
export function newSecret() {
  return loaded().new_secret();
}

/** A value signed with a person's key, as their agent knows their words by (fettled-room's capability.rs): with its `sig`. */
export function signed(key, value) {
  return { ...value, sig: loaded().sign(key, JSON.stringify(value)) };
}

/** A connection to a relay: `{ send(frame), close() }`. `on`: `frame(text)`; `closed()`, once. `link`: how it is kept (fettled-room's
 *  `Link`). */
function socketLink(url, after, on, link) {
  const ws = new WebSocket(`${url}?after=${after}`);
  let answered = true, gone = false;
  const ping = setInterval(() => {
    if (!answered) return ws.close();
    answered = false;
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, link.pingEvery);
  ws.onmessage = (e) => {
    answered = true;
    if (e.data !== "pong") on.frame(e.data);
  };
  // (Both: a connection that was never made says only `error` in some runtimes, and in browsers says both.)
  ws.onclose = ws.onerror = () => {
    if (gone) return;
    gone = true;
    clearInterval(ping);
    on.closed();
  };
  return {
    send: (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(frame); },
    close: () => ws.close(),
  };
}

/** The same of a host: lines as they come, and what is sent as requests, in the order said (what is said while one goes, all in the
 *  next). `peer()`: this connection's name, which a request says, once the room has told it. */
function streamLink(url, after, on, link, peer) {
  const stop = new AbortController();
  let gone = false, heard = Date.now(), queue = [], sending = false;
  const silentAtMost = link.silentAtMost;
  const closed = () => {
    if (gone) return;
    gone = true;
    clearInterval(watch);
    stop.abort();
    on.closed();
  };
  const watch = setInterval(() => { if (Date.now() - heard > silentAtMost) closed(); }, silentAtMost / 3);
  const pump = async () => {
    if (sending) return;
    sending = true;
    while (queue.length && !gone) {
      const body = `[${queue.join(",")}]`;
      queue = [];
      // (Lost with the connection: what must arrive is sent again when it is back.)
      await fetch(`${url}?peer=${encodeURIComponent(peer())}`, { method: "POST", body, signal: stop.signal }).catch(() => {});
    }
    sending = false;
  };
  (async () => {
    const r = await fetch(`${url}?after=${after}`, { signal: stop.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status}`);
    const lines = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let held = "";
    for (;;) {
      const { value, done } = await lines.read();
      if (done) break;
      heard = Date.now();
      const all = (held + value).split("\n");
      held = all.pop();
      for (const line of all) if (line) on.frame(line);
    }
  })().catch(() => {}).finally(closed);
  return {
    send: (frame) => { queue.push(frame); pump(); },
    close: closed,
  };
}

export class Room {
  /** `relay`: what keeps it (`wss://…`, a relay; `http://…`, a host). `after`: the last entry already had, for a page coming back to a room.
   *  `on`: `entry({ seq, id, from, at, value })`, in order, each once; `peers(list)`; `signal(from, value)`;
   *  `refused(id, why)`; `status("connecting" | "live")`; `caughtUp()`: all there was has been told, each time it connects;
   *  `forgotten()`: the relay no longer has what is had here;
   *  `unreadable({ seq, id, from, at })`: an entry this key does not open (the wrong link, or not from anyone with one).
   *  fettled-room is to have been loaded (`loadRoom`). */
  constructor({ relay, id, secret, after = 0, on = {} }) {
    this.url = `${relay}/rooms/${id}`;
    this.core = new (loaded().RoomPeer)(secret, after);
    this.on = on;
    /** Told in order, though what an entry means may take reading: the next waits for it. */
    this.opening = Promise.resolve();
    this.peers = new Set();
    this.closed = false;
    // (Connected only while the page is: one gone from may be kept by the browser to come back to, and its connection kept open with it
    // would hold one of the six a browser makes to a host (a room on a host is a stream from it): six, and the next page opened there
    // loads nothing. Come back to, it connects again from where it was.)
    this.hidden = false;
    globalThis.addEventListener?.("pagehide", () => { this.hidden = true; this.link?.close(); });
    globalThis.addEventListener?.("pageshow", (e) => { if (!e.persisted) return; this.hidden = false; this.connect(); });
    this.connect();
  }
  /** This connection's name in the room. */
  get peer() { return this.core.peer ?? null; }
  /** How much of what was said is not yet in the log. */
  get waiting() { return this.core.waiting; }

  connect() {
    if (this.closed || this.hidden) return;
    this.on.status?.("connecting");
    const open = /^ws/.test(this.url) ? socketLink : streamLink;
    const link = (this.link = open(this.url, this.core.seq, {
      frame: (text) => this.heard(text),
      closed: () => {
        if (this.link !== link || this.closed) return;
        this.core.gone();
        this.on.status?.("connecting");
        setTimeout(() => this.connect(), this.core.retry_after());
      },
    }, JSON.parse(this.core.link), () => this.peer));
  }

  heard(frame) {
    const { heard, send } = JSON.parse(this.core.heard(frame));
    for (const h of heard) {
      if (h.k === "entry") {
        const { k: _, ...entry } = h;
        this.inOrder(() => this.on.entry?.(entry));
      } else if (h.k === "unreadable") {
        const { k: _, ...entry } = h;
        this.inOrder(() => this.on.unreadable?.(entry));
      } else if (h.k === "caughtUp") {
        this.inOrder(() => this.on.caughtUp?.());
      } else if (h.k === "peers") {
        this.peers = new Set(h.list);
        this.on.peers?.(h.list);
      } else if (h.k === "live") {
        this.on.status?.("live");
      } else if (h.k === "forgotten") {
        this.on.forgotten?.();
      } else if (h.k === "signal") {
        try { this.on.signal?.(h.from, h.value); } catch (e) { console.error("room:", e); }
      } else if (h.k === "unopened") {
        console.error(`room: what ${h.from} said does not open with this key`);
      } else if (h.k === "refused") {
        this.on.refused?.(h.id, h.why);
      }
    }
    for (const f of send) this.link.send(f);
  }
  inOrder(f) {
    this.opening = this.opening.then(f).catch((e) => console.error("room:", e));
    return this.opening;
  }

  /** An id for what is about to be said. */
  newId() {
    return loaded().new_id();
  }
  /** Into the log, for everyone: comes back as an entry with its place, in the order said here. Its id (`id`: this one). */
  say(value, id = this.newId()) {
    const frame = this.core.say(JSON.stringify(value), id);
    if (frame) this.link.send(frame);
    return id;
  }
  /** A long text to one peer in as many parts as it takes, each in a frame the room takes: `[[which, of, text]]`. */
  parts(text) {
    return JSON.parse(this.core.parts(text));
  }
  /** To one peer, now or not at all, after what was said here before it. (Its order matters: WebRTC's candidates are no use
   *  ahead of the offer they belong to; sealing here waits for nothing, so each goes as it is said.) */
  signal(to, value) {
    const frame = this.core.signal(to, JSON.stringify(value));
    if (frame) this.link.send(frame);
  }
  close() {
    this.closed = true;
    this.link.close();
  }
}
