// Who is in a shared workspace, or a session on one: their badges in the header, those online and
// those with something unread, and a chat with one of them (outside the issues). Messages are the
// workspace's; what has been read is this browser's (a bell on a badge: something unread from them).
// In a session, a click on someone offers what can be done with them: follow their view, go to them, a message (together.js).

import { $, esc, store, stored } from "../ui.js";
import { workspace } from "../workspace.js";
import { sel, st } from "./state.js";
import { bindRefs, refs, when } from "./issues.js";
import { creatureOf } from "../identity.js";
import { showTab } from "../shell/panel.js";
import { isShown, onLayout, retitle } from "../shell/dock.js";

/** What a session offers of someone, where the page is in one: `follow(who)`, whether it could; `chat(who)`; `menuFor(who, event, chat)`;
 *  `buildOf(who)`: their build of the app, where it is not this person's (`{ beside, said }`), marked on their badge. (How the
 *  connection to each stands is the session's button's to show: session/enter.js.) */
export const personActions = { follow: null, chat: null, menuFor: null, isFollowed: null, buildOf: null };

export const badge = (id, small) => badgeOf(workspace.participant(id), small);
/** What an agent is doing, as its robot's face shows it (by its presence): `[class, said]`. */
const BOT_STATE = { waiting: ["listening", "listening for what is for it"], working: ["working", "working: thinking, or using its tools"], here: ["here", "here"], away: ["away", "not listening just now"] };
/** A robot's head, its face as it is now: listening (eyes open, a smile), working (eyes up and to one side, its antenna lit), here
 *  (dots, a level mouth), away (eyes shut, a z). One drawing, its features white on the agent's colour. */
function botFace(state) {
  const W = `stroke="#fff" stroke-width="1.7" stroke-linecap="round" fill="none"`;
  const face = {
    listening: `<circle cx="8.6" cy="12" r="2" fill="#fff"/><circle cx="15.4" cy="12" r="2" fill="#fff"/><path d="M8.8 16.2q3.2 2.2 6.4 0" ${W}/>`,
    working: `<circle cx="8.6" cy="12" r="2.3" fill="#fff"/><circle cx="15.4" cy="12" r="2.3" fill="#fff"/><circle cx="9.4" cy="11.1" r="1.1" fill="var(--bot-ink)"/><circle cx="16.2" cy="11.1" r="1.1" fill="var(--bot-ink)"/><path d="M10.5 16.8h3" ${W}/>`,
    here: `<circle cx="8.6" cy="12.2" r="1.5" fill="#fff"/><circle cx="15.4" cy="12.2" r="1.5" fill="#fff"/><path d="M9.5 16.4h5" ${W}/>`,
    away: `<path d="M6.8 12.4q1.8 1.3 3.6 0M13.6 12.4q1.8 1.3 3.6 0" ${W}/><path d="M10.6 16.4h2.8" ${W}/>`,
  }[state];
  const lit = state === "working" ? "#ffcf3f" : state === "away" ? "rgba(255,255,255,.55)" : "#fff";
  return `<svg class="botface" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.2V3" stroke="var(--bot-ink)" stroke-width="1.6" stroke-linecap="round"/><circle class="tip" cx="12" cy="2.6" r="1.7" fill="${lit}" stroke="var(--bot-ink)" stroke-width="1"/><rect x="1.4" y="10" width="2.2" height="5" rx="1" fill="var(--bot-ink)"/><rect x="20.4" y="10" width="2.2" height="5" rx="1" fill="var(--bot-ink)"/><rect x="3.2" y="5.2" width="17.6" height="15.6" rx="5" fill="var(--who)" stroke="var(--bot-ink)" stroke-width="1.2"/>${face}${state === "away" ? `<text x="19.5" y="7.2" font-size="6" font-weight="700" fill="var(--bot-ink)" font-family="sans-serif">z</text>` : ""}</svg>`;
}
/** A badge for someone: `{ name, kind, colour, picture, of?, presence? }`. An agent is a robot, its face showing what it does, with its
 *  person's badge small behind it, over its shoulder: theirs, and not taken for them. */
export function badgeOf(p, small) {
  if (p.kind === "agent") {
    const owner = p.of && workspace.state?.participants.find((q) => q.id === p.of && q.kind !== "agent");
    const [state, said] = BOT_STATE[p.presence] ?? BOT_STATE.here;
    const behind = owner ? `<span class="botof">${badgeOf(owner, true).replace(/ title="[^"]*"/, "")}</span>` : "";
    return `<span class="whobot ${state}${small ? " small" : ""}${owner ? " of" : ""}" style="--who:${esc(p.colour)}" title="${esc(p.name)}: ${owner ? `${esc(owner.name)}'s agent` : "an agent"}, ${said}">${behind}${botFace(state)}</span>`;
  }
  const initials = p.name.slice(0, 1).toUpperCase();
  // A person with no picture: the creature of their name.
  const creature = !p.picture ? creatureOf(p.name) : null;
  const picture = p.picture ? `;background-image:url(${esc(p.picture)});background-size:cover;color:transparent` : creature ? `;background-image:url(${esc(creature.picture)})` : "";
  return `<span class="who${small ? " small" : ""}${creature ? " creature" : ""}" style="--who:${esc(p.colour)}${picture}" title="${esc(p.name)}${creature ? ` (a ${esc(creature.name.toLowerCase())})` : ""}">${creature ? "" : esc(initials)}</span>`;
}
const WARN = `<svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 1 11.4 10.6H.6z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M6 4.4v3M6 8.9v.1" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const BELL = `<svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 1.2c-2 0-3.2 1.5-3.2 3.4 0 2-.6 3-1.3 3.6h9c-.7-.6-1.3-1.600-1.300-3.600 0-1.900-1.200-3.400-3.200-3.400z M4.800 9.300a1.250 1.250 0 0 0 2.400 0" fill="currentColor"/></svg>`;

// The chat: a panel of the dock (its tab counts what is unread), the session's group chat to begin with, and a thread with any one of
// those in it, chosen above it or from their badge in the header. Messages are the session's; what has been read is this browser's.
/** The group's thread, as a thread is named (one with someone is their id). */
export const EVERYONE = "everyone";
const chatRead = stored("fettled.chat.read", {});
const theirs = (m) => m.from !== workspace.id;
/** The messages of a thread: to everyone, or between this person and someone. */
const thread = (t) => (st?.chat || []).filter((m) => (t === EVERYONE ? m.to == null : (m.from === t && m.to === workspace.id) || (m.from === workspace.id && m.to === t)));
const unreadIn = (t) => thread(t).filter((m) => theirs(m) && m.time > (chatRead[t] ?? 0)).length;
const unreadFrom = (peer) => unreadIn(peer);
/** The threads there are: the group's, then each with someone who has said something to this person, or is here. */
function threads() {
  const others = (st?.participants ?? []).filter((p) => p.id !== workspace.id && (p.presence !== "away" || thread(p.id).length));
  return [EVERYONE, ...others.map((p) => p.id)];
}
/** Whether there is anyone to chat with: in a session. */
const live = () => !!workspace.together;

/** Its tab: "Chat", and how many messages are unread. */
export const chatLabel = () => {
  const n = live() ? threads().reduce((a, t) => a + unreadIn(t), 0) : 0;
  return `Chat <span class="count${n ? " warn" : ""}" title="${n ? `${n} unread` : ""}">${n || ""}</span>`;
};

personActions.chat = (peer) => openChat(peer);
/** The chat brought up, at a thread (none: the group's). */
export function openChat(t = EVERYONE) {
  sel.chat = t;
  showTab("chat");
  renderChat(true);
  renderPeople();
}

/** The panel, made once: threads above, the messages, and where to write. */
function chatBox() {
  let box = $("chatPane");
  if (box.dataset.made) return box;
  box.dataset.made = "1";
  box.innerHTML = `<div class="cthreads"></div><div class="cnote muted"></div><div class="clist"></div><textarea rows="2"></textarea>`;
  box.querySelector(".cthreads").onclick = (e) => { const t = e.target.closest("[data-t]")?.dataset.t; if (t) openChat(t); };
  const ta = box.querySelector("textarea");
  ta.onkeydown = async (e) => {
    e.stopPropagation();
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    const t = sel.chat ?? EVERYONE;
    const r = await workspace.call("chat", { action: "send", to: t === EVERYONE ? null : t, text });
    if (r.error) { alert(r.error); ta.value = text; }
  };
  return box;
}

export function renderChat(focus) {
  if (!$("chatPane")) return;
  const box = chatBox(), list = box.querySelector(".clist"), ta = box.querySelector("textarea");
  if (!live()) {
    box.classList.add("none");
    box.querySelector(".cthreads").innerHTML = "";
    box.querySelector(".cnote").textContent = "";
    list.innerHTML = `<div class="muted" style="padding:12px">The chat is live, in a session: everyone in it, and their agents. Start one from Share.</div>`;
    list.dataset.key = "";
    ta.hidden = true;
    return retitle();
  }
  box.classList.remove("none");
  ta.hidden = false;
  const all = threads();
  if (!all.includes(sel.chat)) sel.chat = EVERYONE;
  const t = sel.chat, peer = t === EVERYONE ? null : st.participants.find((p) => p.id === t);
  box.querySelector(".cthreads").innerHTML = all.map((x) => {
    const p = x === EVERYONE ? null : st.participants.find((q) => q.id === x), n = unreadIn(x);
    const label = p ? `${badge(p.id, true)} ${esc(p.name)}` : "Everyone";
    return `<button data-t="${esc(x)}" class="${x === t ? "on" : ""}" title="${p ? `Between you and ${esc(p.name)}` : "Everyone in the session: an agent hears what has @its name in it"}">${label}${n ? ` <b class="count warn">${n}</b>` : ""}</button>`;
  }).join("");
  const agent = peer?.kind === "agent";
  box.querySelector(".cnote").textContent = agent && peer.presence === "away" ? `${peer.name} is not listening just now: it gets this when it next is.` : peer && !agent && peer.presence === "away" ? `${peer.name} is away: they see this when they are back.` : "";
  ta.placeholder = peer ? `Say something to ${peer.name}… (Enter sends)` : "Say something to everyone… (@name for an agent; Enter sends)";
  const msgs = thread(t), key = `${t}:${msgs.length}`;
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    const nameOf = (id) => st.participants.find((p) => p.id === id)?.name ?? "someone";
    list.innerHTML = msgs.map((m) => `<div class="cmsg ${theirs(m) ? "theirs" : "mine"}">${t === EVERYONE && theirs(m) ? `<div class="cby">${badge(m.from, true)} ${esc(nameOf(m.from))}</div>` : ""}<div class="text">${refs(m.text)}</div><span class="muted">${when(m.time)}</span></div>`).join("") ||
      `<div class="muted" style="padding:6px 2px">${peer ? `Nothing said yet. ${agent ? "Ask it something, or what it is doing. For something about a place in the building, raise an issue: it will see that too." : ""}` : "Nothing said yet. What is said here everyone in the session sees; an agent, where it has @its name in it."}</div>`;
    list.scrollTop = list.scrollHeight;
    bindRefs(list);
  }
  // Seen, where it is in sight.
  const last = msgs.filter(theirs).reduce((a, m) => Math.max(a, m.time), 0);
  if (isShown("tool:chat") && last > (chatRead[t] ?? 0)) { chatRead[t] = last; store("fettled.chat.read", chatRead); }
  retitle();
  if (focus) ta.focus();
}
const PRESENCE = { here: "here", working: "working", waiting: "listening", away: "away" };
export function renderPeople() {
  const box = $("people");
  box.hidden = !workspace.can("people");
  // (Online; or not, with something from them not yet read.)
  // (Not this person: they are the account button, apart.)
  const listed = st.participants.filter((p) => p.id !== workspace.id && (p.presence !== "away" || unreadFrom(p.id)));
  box.innerHTML = listed.map((p) => {
    const me = p.id === workspace.id, n = me ? 0 : unreadFrom(p.id), followable = !me && p.presence !== "away" && personActions.follow;
    const other = !me && p.presence !== "away" ? personActions.buildOf?.(p.id) : null;
    const does = followable || other ? `. Click to follow their view, go to them or send a message${other ? ", and for their build" : ""}${n ? ` (${n} unread)` : ""}` : `. Click to chat${n ? ` (${n} unread)` : ""}`;
    return `<span class="person ${p.presence}${me ? " me" : ""}${sel.chat === p.id && isShown("tool:chat") ? " chatting" : ""}${personActions.isFollowed?.(p.id) ? " followed" : ""}" data-id="${esc(p.id)}" title="${esc(p.name)} — ${p.kind === "agent" ? "agent, " : ""}${PRESENCE[p.presence]}${me ? " (you: click to change your name)" : does}">${badge(p.id)}${personActions.follow ? "" : "<i></i>"}${n ? `<b class="bell" title="${n} unread">${BELL}</b>` : ""}${other ? `<b class="buildwarn" title="${esc(other.said)}">${WARN}</b>` : ""}</span>`;
  }).join("");
  for (const s of box.querySelectorAll(".person:not(.me)")) {
    const id = s.dataset.id;
    // (The bell, or anyone offline: what they said. Someone on another build: what can be done with them, and what their build is.)
    s.onclick = (e) => {
      if (e.target.closest(".bell")) return openChat(id);
      // (In a session, what can be done with them, to choose from; else, what they said.)
      if (personActions.menuFor && st.participants.find((p) => p.id === id)?.presence !== "away") return personActions.menuFor(id, e, () => openChat(id));
      openChat(id);
    };
    s.oncontextmenu = (e) => { if (!personActions.menuFor) return; e.preventDefault(); personActions.menuFor(id, e, () => openChat(id)); };
  }
}

// (The chat brought into sight: what it shows is read now.)
onLayout(() => renderChat());
