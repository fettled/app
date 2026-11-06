// What is only for showing (docs/collaboration.md, "Seeing each other"): a data channel to each peer that keeps no order and
// sends nothing twice, so that what is late is lost rather than holding up what is newer. There is no way round: two peers that
// cannot connect are told so, and what they would have seen is simply not there. WebRTC's negotiation goes by the room's signals.
// A connection that fails, or is lost, is made again from the start, a while later and then less often: each attempt is numbered
// (`gen`), every signal says which it is of, and whichever side tries again first tells the other, which starts that one too.
// Each open connection is pinged, and its answer timed: how long a round trip takes, and how long since the peer was last heard,
// say how it stands now (`health`); one that has answered and then falls silent is taken to be lost, sooner than WebRTC would.

/** How long a connection is given before it is said to have failed. */
const CONNECT_WITHIN = 15000;
/** How long after failing a connection is tried again, at first and at most (doubling between, till one is made). */
const AGAIN_AFTER = 2000, AGAIN_AT_MOST = 30000;
/** Where a peer learns how the internet sees it. No relay of data (TURN): a pair that needs one cannot connect, and that is said. */
const ICE = [{ urls: "stun:stun.cloudflare.com:3478" }];
/** How often an open connection is pinged. */
const PING_EVERY = 2000;
/** Silent this long, a connection is said to be faltering; this long, lost (and tried again). A round trip this long is slow. */
const FALTERING_AFTER = 5000, LOST_AFTER = 12000, SLOW_TRIP = 250;

export class Mesh {
  /** `signal(peer, value)`: to one peer, by the room. `on`: `packet(peer, value)`; `state(peer, "connecting" | "open" | "failed")`;
   *  `health(peer, health)`, at each answer and each change (`health()`). `RTC`: what makes connections. */
  constructor({ signal, on = {}, RTC = globalThis.RTCPeerConnection }) {
    Object.assign(this, { signal, on, RTC });
    this.links = new Map();
    /** How long each peer is next waited for, after failing. */
    this.waits = new Map();
    this.me = null;
    this.pinging = null;
  }
  /** Who is here now (by the relay's ids), and which of them this is. Each pair connects; those gone are let go of. */
  peersAre(me, list) {
    this.me = me;
    const now = new Set(list);
    for (const peer of [...this.links.keys()]) if (!now.has(peer)) this.drop(peer);
    for (const peer of list) if (peer !== me && !this.links.has(peer)) this.link(peer, 0);
  }
  /** A peer's state now: "connecting", "open", "failed"; undefined: no such peer. */
  stateOf(peer) {
    return this.links.get(peer)?.state;
  }
  /** How a connection stands now, to be shown: `{ level, trip, silent }`. `level`: "good"; "poor" (connecting, slow, or not heard
   *  from lately); "down" (not connected: it is being tried again). `trip`: the last round trip, ms; `silent`: ms since last heard.
   *  Undefined: no such peer. */
  health(peer) {
    const l = this.links.get(peer);
    if (!l) return undefined;
    if (l.state === "failed") return { level: "down", trip: null, silent: null };
    if (l.state !== "open") return { level: "poor", trip: null, silent: null };
    const silent = performance.now() - l.heard;
    return { level: silent > FALTERING_AFTER || l.trip > SLOW_TRIP ? "poor" : "good", trip: l.trip, silent };
  }
  /** How each connection stands, for finding out why one has not been made. */
  report() {
    return [...this.links.values()].map((l) => ({ peer: l.peer, gen: l.gen, state: l.state, trip: l.trip, offers: l.offers, connection: l.pc.connectionState, ice: l.pc.iceConnectionState, signaling: l.pc.signalingState, channel: l.channel.readyState, mine: l.mine, theirs: l.theirs }));
  }
  /** Why a peer could not be reached directly, as far as can be told from the addresses each side said it had; null: it was. */
  whyNot(peer) {
    const l = this.links.get(peer);
    if (!l || l.state !== "failed") return null;
    const said = (kinds) => Object.keys(kinds).join(", ") || "none";
    const has = `this side's addresses: ${said(l.mine)}; theirs: ${said(l.theirs)}`;
    if (!Object.keys(l.theirs).length) return `none of their addresses arrived (${has})`;
    if (!l.mine.public && !l.theirs.public) return `neither side learnt its public address from STUN (${has})`;
    return `addresses were exchanged but none answered (${has}). On one network: the browser may need to be let reach local devices (macOS: System Settings › Privacy & Security › Local Network), or the Wi-Fi keeps devices apart`;
  }
  /** Whether anyone would hear what is sent. */
  get anyone() {
    for (const l of this.links.values()) if (l.state === "open") return true;
    return false;
  }
  set(l, state) {
    if (l.state === state) return;
    l.state = state;
    clearTimeout(l.timer);
    if (state === "failed") {
      console.warn("session: no direct connection to", l.peer, this.whyNot(l.peer));
      this.again(l);
    }
    if (state === "open") {
      // (Made after all, late: no new attempt.)
      clearTimeout(l.again);
      l.again = null;
      this.waits.delete(l.peer);
      l.heard = performance.now();
      this.pinging ??= setInterval(() => this.ping(), PING_EVERY);
      this.ping1(l);
    }
    this.on.state?.(l.peer, state);
    this.told(l);
  }
  /** Each open connection pinged, and each looked at: one silent too long, that has answered before, is lost. (One that never has
   *  may be of a build that does not answer.) */
  ping() {
    for (const l of this.links.values()) {
      if (l.state !== "open") continue;
      if (l.answers && performance.now() - l.heard > LOST_AFTER) {
        console.warn("session: nothing heard from", l.peer, `for ${Math.round(LOST_AFTER / 1000)} s`);
        this.set(l, "failed");
        continue;
      }
      this.ping1(l);
      this.told(l);
    }
  }
  ping1(l) {
    if (l.channel.readyState === "open") l.channel.send(JSON.stringify({ ping: performance.now() }));
  }
  /** Says how a connection stands, where that has changed. */
  told(l) {
    const h = this.health(l.peer);
    if (!h || this.links.get(l.peer) !== l) return;
    const said = `${h.level} ${h.trip == null ? "" : Math.round(h.trip)}`;
    if (said === l.said) return;
    l.said = said;
    this.on.health?.(l.peer, h);
  }
  /** Tries again, a while from now, unless something has already: this side starts a new attempt and tells the other. */
  again(l) {
    if (l.again || this.links.get(l.peer) !== l) return;
    const wait = this.waits.get(l.peer) ?? AGAIN_AFTER;
    this.waits.set(l.peer, Math.min(2 * wait, AGAIN_AT_MOST));
    l.again = setTimeout(() => {
      if (this.links.get(l.peer) !== l) return;
      this.link(l.peer, l.gen + 1);
      this.signal(l.peer, { rtc: { gen: l.gen + 1 } });
    }, wait);
  }
  /** A connection to a peer, attempt `gen`, in place of any before it. (One that had failed is still said to have, till one is made.) */
  link(peer, gen) {
    const was = this.links.get(peer);
    const pc = new this.RTC({ iceServers: ICE });
    // (One of a pair offers, by their ids, so that offers never cross: a first offer rolled back to take the other's leaves
    // a data channel that never opens.)
    // (`mine`, `theirs`: how many addresses of each kind each side said it had, to say why when nothing connects.)
    // (`heard`: when anything last came from them; `trip`: the last ping's round trip, ms; `answers`: they answer pings.)
    const l = { peer, gen, pc, state: was?.state === "failed" ? "failed" : null, offers: this.me > peer, timer: null, again: null, channel: null, mine: {}, theirs: {}, heard: 0, trip: null, answers: false, said: null };
    this.links.set(peer, l);
    if (was) this.end(was);
    if (l.state !== "failed") this.set(l, "connecting");
    l.timer = setTimeout(() => (l.state === "failed" ? this.again(l) : this.set(l, "failed")), CONNECT_WITHIN);
    // (Negotiated: both make the one channel, and neither has to wait to be offered it.)
    l.channel = pc.createDataChannel("motion", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    l.channel.onopen = () => this.set(l, "open");
    l.channel.onclose = () => { if (this.links.get(peer) === l) this.set(l, "failed"); };
    l.channel.onmessage = (e) => {
      let v;
      try { v = JSON.parse(e.data); } catch (_) { return; /* not one of ours */ }
      l.heard = performance.now();
      if (v.ping != null) {
        if (l.channel.readyState === "open") l.channel.send(JSON.stringify({ pong: v.ping }));
      } else if (v.pong != null) {
        l.trip = l.heard - v.pong;
        l.answers = true;
        this.told(l);
      } else this.on.packet?.(peer, v);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      count(l.mine, candidate.candidate);
      this.signal(peer, { rtc: { candidate, gen } });
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" && this.links.get(peer) === l) this.set(l, "failed"); };
    if (!l.offers) return l;
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        this.signal(peer, { rtc: { description: pc.localDescription, gen } });
      } catch (e) {
        console.warn("session: negotiating", e);
      }
    };
    return l;
  }
  /** Something of WebRTC's negotiation, from a peer. */
  async signalled(peer, { description, candidate, gen = 0 }) {
    let l = this.links.get(peer);
    // (Of an attempt given up: nothing. Of a newer one: this side starts it too.)
    if (!l || gen < l.gen) return;
    if (gen > l.gen) l = this.link(peer, gen);
    const { pc } = l;
    try {
      if (description) {
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          this.signal(peer, { rtc: { description: pc.localDescription, gen } });
        }
      } else if (candidate) {
        count(l.theirs, candidate.candidate);
        await pc.addIceCandidate(candidate);
      }
    } catch (e) {
      console.warn("session: negotiating", e);
    }
  }
  /** To everyone it can reach, now or not at all. */
  send(value) {
    let text = null;
    for (const l of this.links.values()) {
      if (l.state !== "open" || l.channel.readyState !== "open") continue;
      text ??= JSON.stringify(value);
      l.channel.send(text);
    }
  }
  drop(peer) {
    const l = this.links.get(peer);
    if (!l) return;
    this.links.delete(peer);
    this.waits.delete(peer);
    this.end(l);
  }
  /** Lets go of one attempt. */
  end(l) {
    clearTimeout(l.timer);
    clearTimeout(l.again);
    l.pc.close();
  }
  close() {
    clearInterval(this.pinging);
    this.pinging = null;
    for (const peer of [...this.links.keys()]) this.drop(peer);
  }
}

/** Counts an ICE candidate (its SDP line) by the kind of address it is: on this network (`local`, or `hidden` when only an mDNS
 *  name is given), as the internet sees it (`public`), or by a relay. */
function count(kinds, line = "") {
  const f = line.split(" ");
  const type = f[7], address = f[4] ?? "";
  const kind = type === "host" ? (address.endsWith(".local") ? "hidden" : "local") : type === "relay" ? "relay" : type ? "public" : null;
  if (kind) kinds[kind] = (kinds[kind] ?? 0) + 1;
}
