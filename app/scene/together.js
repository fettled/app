// Others in a session, in the 3D views (docs/collaboration.md, "Seeing each other"). From outside, each is a slate where their
// camera is, with their picture on it and their name by it, and a ray of their colour along their cursor. Through their view
// (following them: chosen from their icon's menu, a double-click on their slate, or their row twice), their camera is this view's until it
// is moved, and what they do with the pointer and keys is drawn over it as a recording's is.
//
// Loaded only for a page in a session. All of it goes by the lossy channel (motion.js), and is drawn as it arrives, with nothing
// held back to smooth it: what is late is worth less than what is lost. Nothing here changes the model.

import { nameOf } from "../ids.js";
import { el, esc, openMenu } from "../ui.js";
import { onDid, recent } from "../actions.js";
import { vec } from "../glview.js";
import * as objects from "../objects.js";
import { workspace } from "../workspace.js";
import { bring, current, focused, onLayout, openDoc } from "../shell/dock.js";
import { msg } from "../shell/panel.js";
import { kind, kindOf } from "./kinds.js";
import { active, sel, views } from "./state.js";
import { choose } from "./chosen.js";
import { partAt } from "./exact.js";
import { addKindRows, renderTree } from "./tree.js";
import { renderTools, theView, toolsAlso, viewDrawn } from "./views.js";
import { lookOf, setLook } from "./look.js";
import { personActions } from "./people.js";
import { Mesh } from "../session/motion.js";
import { SHOWN_ICON, links, showConnection } from "../session/enter.js";
import { buildBeside, buildName } from "../project.js";
import { placeDiffbar } from "./proposals.js";
import { creatureOf } from "../identity.js";

/** The share of the height of a view a slate is, as seen, however far off it is. */
const SLATE_SHARE = 0.09;
/** Its picture: how many pixels high (across, as their view is), and of them how large the circle with who it is. */
const PICTURE_HIGH = 120, CIRCLE = 40;
/** How wide what is drawn over the view is, in points. */
const RAY_WIDTH = 2;
/** The least time between packets of the pointer moving (ms). What it presses or types goes at once. */
const AT_MOST_EVERY = 16;
/** How far a camera has to be from where it was put, for it to have been moved by someone (m, and way, unitless). */
const STEERED = 1e-3;
/** How long a person's last word is kept for (ms): past it, they are taken to be elsewhere, and are not drawn. */
const STALE_AFTER = 30000;
/** Going to someone: this view put once behind and above where they look from, at what they look at, so that their slate and
 *  what they see are both in it: how far behind and above, as shares of how far off what they look at is. */
const GO_TO = { behind: 0.6, above: 0.3 };
/** A ray that points at nothing: this many times as long as its person's slate is high, as this view sees the slate (nothing of
 *  the model, or of where they last pointed), fading out over the far part of it in this many steps, from the share of it where it begins to. */
const FADE_SLATES = 100, FADE_STEPS = 12, FADE_FROM = 0.3;

let session = null, mesh = null;
/** Whether the others see where this person looks from and points, and the keys pressed over a view: on to begin with, and
 *  turned off and on by the button on each view. */
let shown = true;
/** How each connection last stood, as the tree said it (Mesh.health's `level`). */
const levels = new Map();
/** Each peer: what the channel has last said of them: `{ cam, aspect, depth, ray, pointer, at }`. */
const motion = new Map();
/** Who is being followed: `{ who, peer, v, sync, mine, expected }`. */
let following = null;

const rgbOf = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
const personOf = (who) => session?.participants.get(who) ?? null;
const whoOfPeer = (peer) => session?.here.get(peer)?.who;
const typingIn = (t) => t?.closest?.("input, textarea, select, [contenteditable]");

// ----- what is sent of this person -----------------------------------------------------------------------------------------

/** The view this person's pointer or camera is of: the one under the pointer, else the one last used. */
let pointerIn = null;
const theirView = () => pointerIn ?? views[active] ?? Object.values(views)[0] ?? null;
let lastSent = 0, sendLater = 0, pending = [];

function packet() {
  const v = theirView(), cs = v?.scene?.cameraState();
  if (!cs) return null;
  const w = v.canvas.clientWidth || 1, h = v.canvas.clientHeight || 1, p = { c: { at: cs.at, forward: cs.forward, up: cs.up, ortho: cs.ortho ?? null }, a: w / h };
  p.d = Math.max(0.05, vec.dot(vec.sub(v.lookingAt(), cs.at), cs.forward));
  if (pointerIn && lastPointer) {
    const ray = v.ray(lastPointer.x, lastPointer.y), hit = v.state.layers.model ? partAt(v, ray) : null;
    p.r = [...ray.origin, ...ray.dir, hit?.t ?? p.d];
    // (Whether it points at something: else it goes on past where the view looks.)
    p.h = hit ? 1 : 0;
    p.n = [lastPointer.x / w, lastPointer.y / h];
    p.b = lastPointer.buttons;
  }
  if (pending.length) { p.e = pending; pending = []; }
  return p;
}
function send() {
  clearTimeout(sendLater);
  sendLater = 0;
  lastSent = performance.now();
  const p = packet();
  if (p) mesh.send(p);
}
/** Goes now, or (a stream of moves) when it may. */
function sendSoon() {
  const wait = AT_MOST_EVERY - (performance.now() - lastSent);
  if (wait <= 0) send();
  else if (!sendLater) sendLater = setTimeout(send, wait);
}

let lastPointer = null;
const heldNow = (e) => [e.shiftKey && "Shift", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.metaKey && "Cmd"].filter(Boolean).join("+");
let heldWas = "";
/** Modifiers said, where they are not as they were. */
function noteHeld(e) {
  const h = heldNow(e);
  if (h !== heldWas) { heldWas = h; pending.push({ t: "modifiers", held: h }); }
}
const viewOfCanvas = (t) => Object.values(views).find((v) => v.canvas === t) ?? null;
function localPointer(e) {
  if (!mesh.anyone || !shown) return;
  const v = viewOfCanvas(e.target);
  if (!v) {
    if (pointerIn) { pointerIn = null; lastPointer = null; pending.push({ t: "left" }); sendSoon(); }
    return;
  }
  const r = v.canvas.getBoundingClientRect();
  pointerIn = v;
  lastPointer = { x: e.clientX - r.left, y: e.clientY - r.top, buttons: e.buttons };
  noteHeld(e);
  const n = [lastPointer.x / (r.width || 1), lastPointer.y / (r.height || 1)];
  if (e.type === "pointerdown") { pending.push({ t: "press", button: e.button, n }); return send(); }
  if (e.type === "pointerup") { pending.push({ t: "release", button: e.button }); return send(); }
  pending.push({ t: "move", n });
  sendSoon();
}
function localWheel(e) {
  if (!mesh.anyone || !shown || !viewOfCanvas(e.target)) return;
  noteHeld(e);
  pending.push({ t: "scroll", dots: -e.deltaY / 40 });
  sendSoon();
}
const KEY_SHOWN = { " ": "␣", Enter: "⏎", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Tab: "⇥", Backspace: "⌫", Delete: "⌦", Escape: "Esc" };
/** A key pressed, for those watching: not one typed into anything, which may be anything at all, as the join dialog tells them (session/enter.js). */
function localKey(e) {
  if (!mesh.anyone || !shown || typingIn(e.target) || !pointerIn) return;
  noteHeld(e);
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return sendSoon();
  const chord = e.metaKey || e.ctrlKey || e.altKey, label = KEY_SHOWN[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  pending.push(chord ? { t: "key", label: `${heldNow(e)}+${label}` } : e.key.length === 1 ? { t: "text", text: e.key } : { t: "key", label });
  send();
}

/** A view drawn, which it is when its camera has moved: those watching are told. And a follower's camera looked at. */
function drawn(v) {
  checkSteered(v);
  drawPeopleIn(v);
  if (!mesh?.anyone || !shown || v !== theirView()) return;
  const cs = v.scene?.cameraState(), key = cs && JSON.stringify([cs.at, cs.forward, cs.up, cs.ortho, v.canvas.clientWidth, v.canvas.clientHeight]);
  if (key !== lastCamera) { lastCamera = key; sendSoon(); }
  tellVisible(v);
}
let lastCamera = null;

// ----- what is true of this person now -------------------------------------------------------------------------------------

/** What this person has in front of them, for whoever follows them: a drawing or a file, and how a view looks (look.js). */
function tellDoc() {
  const type = focused(), key = type && type !== "view" ? current(type)?.key : null;
  session.present({ doc: key ?? null });
}
let visibleWas = null;
function tellVisible(v) {
  // (Not while following, with theirs borrowed: what is said is this person's own. Nor while not seen.)
  if ((following?.sync && following.v === v) || !shown) return;
  const said = lookOf(v), text = JSON.stringify(said);
  if (text === visibleWas) return;
  visibleWas = text;
  session.present({ visible: said });
}

/** Seen by the others, or not: said to them all (by the room, which loses nothing), and on each view's button. */
function show(on) {
  if (shown === on) return;
  shown = on;
  session.present({ unseen: !on });
  if (on) { visibleWas = null; lastCamera = null; sendSoon(); }
  else { pending = []; pointerIn = null; lastPointer = null; }
  for (const v of Object.values(views)) renderTools(v);
}
/** The button on a view that says, glowing red, that the others see where this person looks from and points; a click turns it off and on. */
function showButton(v) {
  const b = el("span", { class: `grp ${shown ? "shown" : "unshown"}` }, `<button data-shown title="${shown
    ? "The others in this session see where you are looking from and where your pointer is in the 3D views, and the keys you press over one (not what you type in a field). Click to stop showing them"
    : "The others in this session do not see where you are looking from or pointing. Click to show them again"}">${SHOWN_ICON}</button>`);
  b.querySelector("button").onclick = () => show(!shown);
  v.tools.prepend(b);
}

// ----- others, from outside --------------------------------------------------------------------------------------------------

const pictures = new Map();
/** A person's picture on their slate, the shape of their view: their colour, and a circle with their face, or their creature,
 *  once that is had. */
function pictureOf(p, aspect) {
  const h = PICTURE_HIGH, w = Math.max(CIRCLE * 2, Math.round(h * (aspect ?? 1.6))), key = `${p.id}|${p.name}|${p.colour}|${p.picture}|${w}`;
  let had = pictures.get(key);
  if (had) return had;
  const c = new OffscreenCanvas(w, h), g = c.getContext("2d", { willReadFrequently: true });
  const paint = (face, creature) => {
    g.fillStyle = p.colour;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255,255,255,.22)";
    g.fillRect(4, 4, w - 8, h - 8);
    g.beginPath();
    g.arc(w / 2, h / 2, CIRCLE, 0, 2 * Math.PI);
    g.fillStyle = p.colour;
    g.fill();
    // (A face fills the circle; a creature stands in it.)
    if (face && creature) g.drawImage(face, w / 2 - 0.8 * CIRCLE, h / 2 - 0.8 * CIRCLE, 1.6 * CIRCLE, 1.6 * CIRCLE);
    else if (face) {
      g.save();
      g.clip();
      g.drawImage(face, w / 2 - CIRCLE, h / 2 - CIRCLE, 2 * CIRCLE, 2 * CIRCLE);
      g.restore();
    }
    return { w, h, rgba: new Uint8Array(g.getImageData(0, 0, w, h).data) };
  };
  had = { image: paint(null), stamp: `${key} plain` };
  pictures.set(key, had);
  // (An agent's is its person's face, as its badge is.)
  const of = (p.kind === "agent" && p.of && personOf(p.of)) || p, creature = !of.picture, face = new Image();
  face.crossOrigin = "anonymous";
  face.onload = () => { had.image = paint(face, creature); had.stamp = `${key} face`; drawPeople(); };
  face.src = of.picture ?? creatureOf(of.name).picture;
  return had;
}

/** The peers to draw: who has said where they are, is not long silent and is shown, and is not who this view is following.
 *  Of one following this person, only their cursor: their slate would stand where this person looks from, in the way. */
/** Where a peer looks from: what the lossy channel last said, while it is not long silent; else what they say of themselves in the room
 *  (an agent's camera, where a render tool last drew it a view: it has no channel, and it holds till it looks elsewhere). */
function seenOf(peer) {
  const m = motion.get(peer);
  if (m?.cam && performance.now() - m.at <= STALE_AFTER) return m;
  const cam = session.here.get(peer)?.camera;
  return cam ? { cam: { at: cam.at, forward: cam.forward, up: cam.up, ortho: cam.ortho ?? null }, aspect: cam.aspect, depth: cam.depth, at: performance.now(), ray: null } : null;
}

function shownIn(v) {
  const out = [];
  for (const peer of new Set([...motion.keys(), ...session.here.keys()])) {
    const who = whoOfPeer(peer), p = who && personOf(who), m = seenOf(peer);
    if (!p || !m || !objects.vis(`person:${who}`) || !session.here.has(peer) || session.here.get(peer).unseen) continue;
    if (following?.peer === peer && following.v === v) continue;
    out.push({ peer, who, p, m, follower: session.here.get(peer)?.following === session.me.who });
  }
  return out;
}
/** Where someone's slate stands, for this view to see it as large whatever the distance: its corners, the first row's ends then the last's. */
function slateIn(v, { cam, aspect, depth }) {
  const at = cam.ortho != null ? vec.add(cam.at, vec.scale(cam.forward, depth)) : cam.at;
  const mine = v.camera(), pixel = mine ? (mine.ortho ? (2 * mine.hh) / mine.h : (2 * Math.tan(mine.fov / 2) * Math.max(0.05, vec.dot(vec.sub(at, mine.eye), mine.forward))) / mine.h) : 0.01;
  const h = (SLATE_SHARE * (mine?.h ?? 600) * pixel) / 2, w = h * aspect, right = vec.unit(vec.cross(cam.forward, cam.up));
  return [[-w, h], [w, h], [-w, -h], [w, -h]].map(([a, b]) => vec.add(at, vec.add(vec.scale(right, a), vec.scale(cam.up, b))));
}
/** The box about points given flat; null of none. */
function extentOf(xyz) {
  if (!xyz.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < xyz.length; i++) { lo[i % 3] = Math.min(lo[i % 3], xyz[i]); hi[i % 3] = Math.max(hi[i % 3], xyz[i]); }
  return { lo, hi };
}
/** Everyone, as this view sees them. Only what it has changed is sent on: this is done whenever anything moves. */
function drawPeopleIn(v) {
  if (!v.scene || !session) return;
  const pos = [], col = [], markers = [], slates = [], areas = new Map(), list = shownIn(v);
  const line = (a, b, rgb) => { pos.push(...a, ...b); col.push(...rgb, 255, ...rgb, 255); };
  for (const { peer, who, p, m, follower } of list) {
    const rgb = rgbOf(p.colour);
    if (!follower) {
      const c = slateIn(v, m), pic = pictureOf(p, m.aspect);
      slates.push({ key: `person ${peer}`, corners: c, image: pic.image, stamp: pic.stamp });
      areas.set(who, [c[0], c[1], c[3], c[2]]);
      for (const [a, b] of [[0, 1], [1, 3], [3, 2], [2, 0]]) line(c[a], c[b], rgb);
      const top = vec.scale(vec.add(c[0], c[1]), 0.5);
      markers.push({ id: `name ${peer}`, at: top, text: { text: p.name, on: true, colour: [255, 255, 255, 255], background: [...rgb, 235], size: 11 }, tip: `${p.name}: double-click their slate to follow their view` });
    }
    if (m.ray && m.hit) {
      const o = m.ray.slice(0, 3), d = m.ray.slice(3, 6), end = vec.add(o, vec.scale(d, m.ray[6]));
      line(o, end, rgb);
      markers.push({ id: `cursor ${peer}`, at: end, shape: "dot", size: m.buttons ? 13 : 9, fill: [...rgb, 255], edge: [255, 255, 255, 255], edge_width: 1.5 });
    } else if (m.ray) {
      // (At nothing: it goes on, and fades out into the distance.)
      const c = slateIn(v, m), high = Math.hypot(...vec.sub(c[0], c[2]));
      const o = m.ray.slice(0, 3), d = m.ray.slice(3, 6), far = FADE_SLATES * high, at = (f) => vec.add(o, vec.scale(d, f * far));
      const alpha = (f) => Math.round(255 * Math.min(1, (1 - f) / (1 - FADE_FROM)));
      pos.push(...o, ...at(FADE_FROM));
      col.push(...rgb, 255, ...rgb, 255);
      for (let k = 0; k < FADE_STEPS; k++) {
        const f0 = FADE_FROM + ((1 - FADE_FROM) * k) / FADE_STEPS, f1 = FADE_FROM + ((1 - FADE_FROM) * (k + 1)) / FADE_STEPS;
        pos.push(...at(f0), ...at(f1));
        col.push(...rgb, alpha(f0), ...rgb, alpha(f1));
      }
    }
  }
  v.peopleAreas = areas;
  const text = JSON.stringify([pos, col]);
  if (v.peopleOver !== text) {
    v.peopleOver = text;
    v.setOver("people", pos.length ? { pos: new Float32Array(pos), col: new Uint8Array(col), width: RAY_WIDTH } : null);
  }
  const said = JSON.stringify(markers);
  if (v.peopleMarkers !== said) {
    v.peopleMarkers = said;
    v.setMarkers("people", markers.length ? { markers } : null);
  }
  const placed = JSON.stringify(slates.map((s) => [s.key, s.corners, s.stamp]));
  if (v.peopleSlates !== placed) {
    v.peopleSlates = placed;
    v.setSlateSet("people", slates);
    // (They are among what is drawn, for how near and far the view sees: they may well be away from the model.)
    v.setExtent("people", extentOf(pos));
  }
}
function drawPeople() {
  for (const v of Object.values(views)) drawPeopleIn(v);
}

// ----- following ---------------------------------------------------------------------------------------------------------------

/** Whom following this person comes to: whoever they are following, and so on (none of it round to this person). */
function followedThrough(who) {
  const seen = new Set([session.me.who]);
  for (let at = who; ;) {
    seen.add(at);
    const next = session.here.get(session.peerOf(at))?.following;
    if (!next || seen.has(next)) return at;
    at = next;
  }
}
/** Follows someone in a view: their camera is its camera till it is moved. Whether they could be followed. */
export function follow(who, v = theView()) {
  who = followedThrough(who);
  const peer = session.peerOf(who), p = personOf(who);
  if (!peer || !p || who === session.me.who || session.here.get(peer)?.unseen) return false;
  if (following) stop();
  bring(v.key);
  following = { who, peer, v, sync: false, mine: { camera: v.get().camera }, expected: null };
  v.scene?.watch?.(rgbOf(p.colour).map((x) => x / 255));
  bindBanner();
  // (Seeing what they see, to begin with: following is for talking about the same thing.)
  setSync(true);
  session.present({ following: who });
  const m = seenOf(peer);
  if (m?.cam) track(m);
  showDoc();
  renderBanner();
  drawPeople();
  renderTree();
  return true;
}
/** Goes to someone, once: this view behind and above them, looking at what they look at (a third person's view of them), not
 *  following them after. Whether it could. */
export function goTo(who, v = theView()) {
  const peer = session.peerOf(who), m = peer && seenOf(peer);
  if (!m?.cam || who === session.me.who || session.here.get(peer)?.unseen) return false;
  if (following?.v === v) stop();
  bring(v.key);
  const { at, forward, up } = m.cam, depth = m.depth ?? 1, target = vec.add(at, vec.scale(forward, depth));
  const from = vec.add(vec.sub(at, vec.scale(forward, GO_TO.behind * depth)), vec.scale(up, GO_TO.above * depth));
  const look = vec.unit(vec.sub(target, from)), side = vec.unit(vec.cross(look, up));
  v.track({ at: from, forward: look, up: vec.cross(side, look), ortho: m.cam.ortho != null ? m.cam.ortho * (1 + GO_TO.behind) : null, flat: false, photo: null });
  return true;
}
/** What can be done with someone in the session, as a menu's items. */
function itemsFor(who, chat) {
  const here = !!session.peerOf(who) && who !== session.me.who, seen = here && !!seenOf(session.peerOf(who));
  const items = [
    here && { label: "Follow their view", title: "This view is theirs till you move it", run: () => follow(who) },
    seen && { label: "Go to them", title: "This view put behind them, once, looking at what they look at", run: () => goTo(who) },
    who !== session.me.who && { label: "Send a message", run: chat },
  ].filter(Boolean);
  const other = personActions.buildOf(who);
  // (Below them, what their build is, where it is another: a fact, not something to do.)
  if (other) items.push(null, { label: other.said, cls: "warn" });
  return items;
}

/** Let go of them: the view stays where it is, what is visible is the viewer's own again. */
export function stop() {
  const f = following;
  if (!f) return;
  following = null;
  session.present({ following: null });
  if (f.sync) unsync(f);
  f.v.scene?.watch?.(undefined);
  f.banner?.remove();
  f.frame?.remove();
  drawPeople();
  renderTree();
  renderTools(f.v);
}
function track(m) {
  const f = following, cam = { at: m.cam.at, forward: m.cam.forward, up: m.cam.up, ortho: m.cam.ortho, flat: false, photo: null };
  f.expected = cam;
  f.v.track(cam);
  placeFrame(m);
}
/** The view moved by something other than what it is following: the person watching has gone their own way. */
function checkSteered(v) {
  const f = following;
  if (f?.v !== v || !f.expected) return;
  const c = v.scene?.cameraState();
  if (!c) return;
  const off = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (off(c.at, f.expected.at) > STEERED || off(c.forward, f.expected.forward) > STEERED || off(c.up, f.expected.up) > STEERED || Math.abs((c.ortho ?? 0) - (f.expected.ortho ?? 0)) > STEERED) stop();
}
/** Their pointer, in this canvas's pixels: a view fits their height, and is centred across, whatever size each is. */
function inMine(f, m, n) {
  const c = f.v.canvas, h = c.height, w = c.width, theirW = h * (m.aspect ?? w / h);
  return { x: w / 2 + (n[0] - 0.5) * theirW, y: n[1] * h };
}
function watchEvents(f, m, events) {
  const out = [];
  for (const e of events) {
    if (e.t === "move") out.push({ t: "move", ...inMine(f, m, e.n) });
    else if (e.t === "press") out.push({ t: "press", button: e.button, ...inMine(f, m, e.n) });
    else if (e.t === "release") out.push({ t: "release", button: e.button });
    else if (e.t === "scroll") out.push({ t: "scroll", dots: e.dots });
    else if (e.t === "modifiers") out.push({ t: "modifiers", held: e.held });
    else if (e.t === "key") out.push({ t: "key", label: e.label });
    else if (e.t === "text") out.push({ t: "text", text: e.text });
    else if (e.t === "left") out.push({ t: "left" });
  }
  if (out.length) { f.v.scene?.watched?.(out); f.v.redraw(); }
}
/** Their frame, outlined, where their view is another shape from this one. */
function placeFrame(m) {
  const f = following, c = f.v.canvas, h = c.clientHeight, w = c.clientWidth, theirW = h * (m.aspect ?? w / h);
  f.frame ??= f.v.host.appendChild(el("div", { class: "theirframe" }));
  f.frame.style.setProperty("--who", personOf(f.who)?.colour ?? "#888");
  f.frame.style.left = `${w / 2 - theirW / 2}px`;
  f.frame.style.width = `${theirW}px`;
}
/** What they have in front of them, brought up: a drawing, or a file; else the view that follows them. */
function showDoc() {
  const f = following;
  if (!f) return;
  const said = session.here.get(f.peer);
  if (said?.doc) openDoc(said.doc); else bring(f.v.key);
}

// ----- what is visible, as they have it ----------------------------------------------------------------------------------------

function applySync(f) {
  const said = session.here.get(f.peer)?.visible;
  // (Said as look.js says how a view looks; one that says no more than what is hidden is of an older page.)
  if (!said?.scene) return;
  objects.borrow(said.hidden, () => { if (following === f && f.sync) { f.sync = false; restoreView(f); renderBanner(); } });
  setLook(f.v, said);
}
/** The view as the person following had it, and the middle of the weight of what they choose again. */
function restoreView(f, keepChoice) {
  const { chosen, ...rest } = f.mine.look;
  setLook(f.v, { ...rest, balance: { on: rest.balance.on }, ...(keepChoice ? {} : { chosen }) });
}
function unsync(f, keepChoice) {
  f.sync = false;
  objects.giveBack();
  restoreView(f, keepChoice);
}
/** Something chosen here, while seeing what they see: this person's own again, with what they chose, still following. */
function choseHere() {
  const f = following;
  if (!f?.sync || !/^app\.select\(/.test(recent.at(-1)?.run ?? "")) return;
  unsync(f, true);
  renderBanner();
}
function setSync(on) {
  const f = following;
  if (!f || f.sync === on) return;
  if (on) {
    f.mine.look = lookOf(f.v);
    f.sync = true;
    applySync(f);
  } else unsync(f);
  renderBanner();
}

// ----- the banner -------------------------------------------------------------------------------------------------------------------

function bindBanner() {
  const f = following;
  f.banner = el("div", { class: "followbar" });
  f.v.floats.append(f.banner);
  f.banner.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "stop") stop();
  });
  f.banner.addEventListener("change", (e) => { if (e.target.dataset.a === "sync") setSync(e.target.checked); });
}
function renderBanner() {
  const f = following;
  if (!f?.banner) return;
  const p = personOf(f.who), said = session.here.get(f.peer);
  f.banner.style.setProperty("--who", p?.colour ?? "#888");
  placeDiffbar(f.v);
  const where = said?.doc ? ` · on ${esc(docName(said.doc))}` : "";
  f.banner.innerHTML = `<b>Following ${esc(p?.name ?? "someone")}</b><span class="muted">${where}</span><label title="See what they see of the model: what is hidden, what the view is clipped to, how bodies are drawn, the marks over it, a photo looked through, what they have chosen. On to begin with; your own settings come back when this is off"><input type="checkbox" data-a="sync"${f.sync ? " checked" : ""}> Same as theirs</label><button data-a="stop" title="Stop following (moving this view does too)">Stop</button>`;
}

// ----- heard --------------------------------------------------------------------------------------------------------------------

function heard(peer, p) {
  const m = motion.get(peer) ?? {};
  motion.set(peer, m);
  m.at = performance.now();
  if (p.c) { m.cam = p.c; m.aspect = p.a; m.depth = p.d; }
  m.ray = p.r ?? null;
  // (Of a page from before it was said: at something.)
  m.hit = p.h !== 0;
  m.buttons = p.b ?? 0;
  const f = following?.peer === peer ? following : null;
  if (f) {
    if (p.c) track(m);
    if (p.e) watchEvents(f, m, p.e);
  }
  // (All views, as it comes: it is waiting that would make it late. Each draws at its next frame.)
  drawPeople();
}
/** Who is here, and what they say of themselves, has changed. */
function peopleChanged() {
  if (following) {
    const said = session.here.get(following.peer);
    if (said?.unseen) msg(`${personOf(following.who)?.name ?? "Whoever you were following"} has stopped showing where they look from.`);
    if (!said || said.unseen) stop();
    else {
      const through = followedThrough(following.who);
      if (through !== following.who) follow(through, following.v);
      else {
        showDoc();
        if (following.sync) applySync(following);
        renderBanner();
      }
    }
  }
  for (const peer of [...motion.keys()]) if (!session.here.has(peer)) motion.delete(peer);
  // (One followed who has no channel, an agent, is followed to where they now say they look from.)
  if (following && !(motion.get(following.peer)?.cam)) { const m = seenOf(following.peer); if (m) track(m); }
  showConnection();
  drawPeople();
  renderTree();
}

// ----- as a kind of thing in the scene --------------------------------------------------------------------------------------------

const stateOfPeer = (peer) => mesh.stateOf(peer);
/** How the direct connection to someone stands, as rows of their info: its round trip, or why there is none. */
function whyNotOf(p) {
  const peer = session.peerOf(p.id), why = peer && mesh.whyNot(peer), h = peer && mesh.health(peer);
  if (why) return [["Why", why]];
  return h?.trip != null ? [["Round trip", `${Math.round(h.trip)} ms`]] : [];
}
/** What a document is called, briefly (its key: `file:a/b.ts`, `sheet:A-101`). */
const docName = (key) => nameOf(key.slice(key.indexOf(":") + 1));
function noteOf(p) {
  const peer = session.peerOf(p.id);
  if (p.id === session.me.who) return "you";
  if (!peer) return "offline";
  if (following?.who === p.id) return "following";
  // (An agent has no page, and so no direct connection: what it says it is doing.)
  if (p.kind === "agent") return p.presence === "waiting" ? "listening" : p.presence === "working" ? "working" : "here";
  if (session.here.get(peer)?.unseen) return "not showing their view";
  const s = stateOfPeer(peer), h = mesh.health(peer);
  if (s === "failed") return "can't connect directly";
  if (s !== "open") return "connecting…";
  if (h?.level === "poor") return h.silent > 4000 ? "not heard from lately" : "slow connection";
  const doc = session.here.get(peer)?.doc;
  return doc ? `on ${docName(doc)}` : "here";
}
/** Which build of the app someone is on, as they said: undefined until they have. */
const buildOf = (p) => (p.id === session.me.who ? session.mine.build : session.here.get(session.peerOf(p.id))?.build);
/** Their build beside this person's, where it is another: "older build", "newer build", "another build"; else "". */
function buildNote(p) {
  const beside = p.id === session.me.who ? "same" : buildBeside(buildOf(p), session.mine.build);
  return beside === "same" ? "" : beside === "other" ? "another build" : `${beside} build`;
}
/** Their row's note: how they are, and their build where it is not this person's. */
const rowNote = (p) => [noteOf(p), buildNote(p)].filter(Boolean).join(" · ");
/** Their build as it stands to this person's, where it is another: `{ beside, said }` ("older", "newer" or "other"; what it is, in words); else null. */
function otherBuild(p) {
  const b = buildOf(p), beside = p.id === session.me.who ? "same" : buildBeside(b, session.mine.build);
  if (beside === "same") return null;
  const than = beside === "other" ? "not yours" : `${beside} than yours`;
  return { beside, said: `On another build of the app: ${buildName(b)}${b.at ? ` (from ${b.at})` : ""}, ${than} (${buildName(session.mine.build)})` };
}
/** Their build, as a row of their info. */
function buildRow(p) {
  const b = buildOf(p), note = buildNote(p);
  return b ? [["App", `${buildName(b)}${b.at ? ` (from ${b.at})` : ""}${note ? `, ${note.replace(" build", "")} than yours` : ""}`]] : [];
}
kind("person", {
  field: "person", group: "participants", order: 3,
  key: (id) => `person:${id}`,
  find: (id) => personOf(id),
  title: (p) => p.name,
  lookThrough: true,
  card: (p) => ({ label: "Participant", id: p.name, note: rowNote(p), body: `<a href="#" data-follow>Follow their view</a>`, bind: (chip) => { const a = chip.querySelector("a[data-follow]"); if (a) a.onclick = (e) => { e.preventDefault(); follow(p.id); }; } }),
  info: (p) => ({ what: "Participant", name: p.name, id: p.login ?? "", rows: [["Now", noteOf(p)], ...whyNotOf(p), ...buildRow(p)], note: "Double-click their slate to follow their view; click their icon at the top right to follow them, go to them or send them a message." }),
  where: () => [],
  rows(row, list) {
    if (!session) return "";
    const everyone = session.people();
    return list("participants", "Participants", () => everyone.map((p) => row(1, "person", `person:${p.id}`, p.name, { id: p.id, on: sel.person === p.id, note: rowNote(p), noEye: p.id === session.me.who, title: p.id === session.me.who ? "You" : `${p.name}. Twice: follow their view` })), { note: everyone.filter((p) => p.presence === "here").length, noEye: true, title: "Everyone who has taken part in this session" });
  },
  goto(id) {
    if (!follow(id)) choose("person", id);
  },
  menu(id, m) {
    for (const it of itemsFor(id, () => personActions.chat?.(id))) if (it?.run) m.add(it.label, it.run);
  },
  near(out, v) {
    for (const [who, q] of v.peopleAreas ?? []) out.area(who, q);
  },
});

/** How the direct connection to someone here stands, for the session's button: `{ name, level, said }`. */
function linkOf(p) {
  const peer = session.peerOf(p.id), h = peer && mesh.health(peer);
  if (!h) return { name: p.name, level: "poor", said: "connecting…" };
  const said = h.level === "down" ? "no direct connection: trying again" : h.trip == null ? "connecting directly…" : h.silent > 4000 ? `not heard from for ${Math.round(h.silent / 1000)} s` : `direct connection, ${Math.round(h.trip)} ms round trip`;
  return { name: p.name, level: h.level, said };
}

/** How the connections to others stand. */
export const connections = () => mesh?.report() ?? [];

/** Starts it: a page's own session, told of everything from here. */
export function attach(s) {
  session = s;
  mesh = new Mesh({
    signal: (peer, value) => session.room.signal(peer, value),
    on: {
      packet: heard,
      state: () => { renderTree(); if (mesh.anyone) { lastCamera = null; sendSoon(); } },
      // (The dots at once; the tree only when what it says has changed.)
      health: (peer, h) => { showConnection(); if (h.level !== levels.get(peer)) { levels.set(peer, h.level); renderTree(); } },
    },
  });
  const peers = () => mesh.peersAre(session.peer, session.others());
  session.on.peers = peers;
  const was = session.on.people;
  // (Someone found to be the host is no one to connect to.)
  session.on.people = () => { was?.(); peers(); peopleChanged(); };
  peers();
  session.listen((from, value) => { if (value.rtc) mesh.signalled(from, value.rtc); });
  // (Only what happens over a view is sent, and only while someone would hear it.)
  for (const type of ["pointermove", "pointerdown", "pointerup"]) document.addEventListener(type, localPointer, { capture: true, passive: true });
  document.addEventListener("wheel", localWheel, { capture: true, passive: true });
  document.addEventListener("keydown", localKey, true);
  document.addEventListener("keyup", (e) => { if (mesh.anyone && !typingIn(e.target)) { noteHeld(e); sendSoon(); } }, true);
  viewDrawn.add(drawn);
  onDid(choseHere);
  onLayout(tellDoc);
  objects.on("visibility", () => { const v = theirView(); if (v) tellVisible(v); });
  objects.open.add("participants");
  addKindRows(kindOf("person"));
  personActions.follow = (who) => follow(who);
  personActions.isFollowed = (who) => following?.who === who;
  links.of = () => session.people().filter((p) => p.id !== session.me.who && p.presence === "here").map((p) => linkOf(p));
  toolsAlso.add(showButton);
  for (const v of Object.values(views)) renderTools(v);
  personActions.buildOf = (who) => { const p = personOf(who); return p ? otherBuild(p) : null; };
  personActions.menuFor = (who, e, chat) => {
    // (Under their badge, where it was clicked on one.)
    const r = e.currentTarget?.getBoundingClientRect?.();
    openMenu(itemsFor(who, chat), r ? r.left : e.clientX, r ? r.bottom + 4 : e.clientY);
  };
  tellDoc();
  showConnection();
  renderTree();
  workspace.refresh();
}
