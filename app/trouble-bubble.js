// What went wrong with nobody there to say so (report.js, `trouble`), said to the person it went wrong for, and easy to
// pass over: a small mark in the page's corner, with how many things went wrong, which a click opens to a list of them,
// each saying what failed and whether it was reported (its id). One of those opened takes what they were doing or saw,
// sent as a report of its own, `details`, naming the one it is about (`extra.about`). Dismissed, the mark goes, till the
// next thing goes wrong.

import { onTrouble, report } from "./report.js";

/** What each kind of trouble is called, to the person it happened to. */
const CALLED = { gpu: "The 3D view's GPU refused something", view: "The 3D view could not be made", uncaught: "Something went wrong", unhandled: "Something went wrong" };

/** The things gone wrong since it was last dismissed, newest last: `{ what, message, id }`. */
const troubles = [];
let mark = null, list = null, count = null;

const BAD = "var(--bad,#c0392b)";

/** The mark, made the first time it is needed. */
function markOf() {
  if (mark?.isConnected) return mark;
  mark = document.createElement("button");
  mark.className = "trouble-mark";
  mark.setAttribute("aria-haspopup", "dialog");
  mark.style.cssText = `position:fixed;right:12px;bottom:12px;z-index:1000;display:flex;align-items:center;gap:3px;height:24px;padding:0 7px 0 5px;border-radius:12px;border:1px solid var(--line,#dcdcd6);background:var(--panel,#fff);color:${BAD};box-shadow:0 1px 4px rgba(0,0,0,.15);font:600 11px/1 system-ui,sans-serif;cursor:pointer;opacity:.85`;
  mark.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="currentColor"/><path d="M8 6v4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="12" r=".9" fill="#fff"/></svg>`;
  count = document.createElement("span");
  mark.append(count);
  mark.addEventListener("pointerenter", () => (mark.style.opacity = "1"));
  mark.addEventListener("pointerleave", () => (mark.style.opacity = ".85"));
  mark.addEventListener("click", () => (list?.isConnected ? closeList() : openList()));
  document.body.appendChild(mark);
  return mark;
}

/** The mark as the troubles are: their number, and what a pointer over it says. */
function showMark() {
  const m = markOf();
  count.textContent = String(troubles.length);
  const reported = troubles.filter((t) => t.id).length;
  m.title = `${troubles.length === 1 ? "Something went wrong" : `${troubles.length} things went wrong`}${reported ? ` (${reported === troubles.length ? "reported" : `${reported} reported`})` : ""}: click to see`;
  m.setAttribute("aria-label", m.title);
  // (A nudge as one comes: once, and small.)
  m.animate?.([{ transform: "scale(1)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 400 });
}

function dismiss() {
  troubles.length = 0;
  closeList();
  mark?.remove();
}

function closeList() {
  list?.remove();
  list = null;
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("pointerdown", onAway, true);
}

function onKey(e) {
  if (e.key === "Escape") closeList();
}

function onAway(e) {
  if (list && !list.contains(e.target) && !mark?.contains(e.target)) closeList();
}

/** The list of what went wrong, over the mark. */
function openList() {
  closeList();
  list = document.createElement("div");
  list.className = "troubles";
  list.setAttribute("role", "dialog");
  list.setAttribute("aria-label", "What went wrong");
  list.style.cssText = "position:fixed;right:12px;bottom:44px;z-index:1000;width:min(340px,calc(100vw - 24px));max-height:min(60vh,420px);overflow:auto;background:var(--panel,#fff);color:var(--ink,#1b1b1b);border:1px solid var(--line,#dcdcd6);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);font-size:12px;line-height:1.35";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line,#dcdcd6)";
  const title = document.createElement("b");
  title.style.flex = "1";
  title.textContent = troubles.length === 1 ? "Something went wrong" : `${troubles.length} things went wrong`;
  const clear = document.createElement("button");
  clear.textContent = "Dismiss";
  clear.style.cssText = "border:0;background:none;color:var(--muted,#6b6b66);cursor:pointer;font:inherit;padding:0";
  clear.addEventListener("click", dismiss);
  head.append(title, clear);
  list.append(head);
  for (const t of [...troubles].reverse()) list.append(item(t));
  document.body.appendChild(list);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onAway, true);
}

/** One thing gone wrong, in the list: what failed, its first line, and whether it was reported, with a way to add to it. */
function item(t) {
  const row = document.createElement("div");
  row.style.cssText = `padding:8px 10px;border-left:3px solid ${BAD};border-bottom:1px solid var(--line,#dcdcd6)`;
  const what = document.createElement("div");
  what.style.fontWeight = "600";
  what.textContent = CALLED[t.what] ?? "Something went wrong";
  const said = document.createElement("div");
  said.textContent = t.message.split("\n")[0].slice(0, 240);
  said.style.cssText = "color:var(--muted,#6b6b66);overflow-wrap:anywhere;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden";
  const status = document.createElement("div");
  status.style.cssText = "margin-top:4px;display:flex;gap:8px;align-items:baseline;color:var(--muted,#6b6b66)";
  const state = document.createElement("span");
  state.textContent = t.added ? `Reported (${t.id}), with what you added` : t.id ? `Reported (${t.id})` : "Not reported (reporting is off, or it could not be sent)";
  status.append(state);
  row.append(what, said, status);
  // (Opened, to add what they were doing: only where it was reported, so that what they add is about something.)
  if (t.id && !t.added) {
    const add = document.createElement("button");
    add.textContent = "Add details";
    add.style.cssText = "border:0;background:none;color:var(--accent,#2a6fdb);cursor:pointer;font:inherit;padding:0";
    status.append(add);
    add.addEventListener("click", () => {
      add.remove();
      const text = document.createElement("textarea");
      text.rows = 3;
      text.placeholder = "What were you doing, and what did you see? e.g. opened the garage door model on my phone; the view was black";
      text.style.cssText = "width:100%;box-sizing:border-box;margin-top:6px;font:inherit;resize:vertical";
      const send = document.createElement("button");
      send.textContent = "Send";
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;justify-content:flex-end;margin-top:6px";
      bar.append(send);
      row.append(text, bar);
      // (What is typed is theirs, not the page's shortcuts'.)
      text.addEventListener("keydown", (e) => e.stopPropagation());
      text.focus();
      send.addEventListener("click", async () => {
        const words = text.value.trim();
        if (!words) return text.focus();
        send.disabled = true;
        const sent = await report("details", { name: "Details", message: words }, { about: t.id, of: t.what });
        text.remove();
        bar.remove();
        if (sent) t.added = true;
        state.textContent = sent ? `Thank you: added to ${t.id}` : "That could not be sent";
      });
    });
  }
  return row;
}

/** A thing gone wrong (`{ what, message, id }`, as `onTrouble` tells it): counted on the mark, and listed. */
export function bubble(t) {
  troubles.push({ ...t });
  showMark();
  // (In the list as it comes, where it is open.)
  if (list?.isConnected) openList();
}

onTrouble(bubble);
