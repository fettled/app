// This person, at the end of the header, apart from the others: who they are to others (a name and a picture, or their creature),
// and a menu to change either, to say whether errors are reported, and to sign in to GitHub or out. On a first visit a card under it asks, once, holding nothing up;
// the card also asks whether what goes wrong here may be reported (report.js), kept as soon as it is ticked or not.

import { $, closeOnAway, el, esc, openMenu } from "../ui.js";
import { auth } from "../auth.js";
import { identity } from "../identity.js";
import { workspace } from "../workspace.js";
import { badgeOf } from "./people.js";
import { leaving } from "../shell/projects.js";
import { REPORTING, reporting, reportingBox, setReporting } from "../report.js";

/** How long after the page opens a first visit is asked who they are: once what they came for is on its way. */
const ASK_AFTER = 1500;

/** This person as a badge has them. */
const meAsShown = () => ({ ...identity.me(), id: workspace.id, kind: "person", colour: workspace.me()?.colour ?? "#5b8def" });

export function initAccount() {
  const box = $("account");
  box.hidden = false;
  box.onclick = () => {
    const r = box.getBoundingClientRect(), login = auth.login();
    openMenu([
      { cls: "head", label: login ? `${identity.name()} · signed in to GitHub as ${login}` : identity.said() ? identity.name() : `${identity.name()} (a guest)`, run: () => {} },
      { label: "Your name and picture…", title: "What others in a session see you as", run: () => openCard() },
      { label: REPORTING.label, checked: reporting(), title: `Reports hold ${REPORTING.what}`, run: () => setReporting(!reporting()) },
      login
        ? { label: "Sign out of GitHub", title: "GitHub is told to take this sign-in back, and it is forgotten here. Edits kept here stay", run: async () => { if (!leaving()) return; await auth.signOut(); location.reload(); } }
        : auth.can() && { label: "Sign in with GitHub", title: "Goes to GitHub, and comes back here: you are then who you are there, with its picture", run: () => auth.signIn() },
    ].filter(Boolean), r.right - 220, r.bottom + 4);
  };
  identity.onChange(() => { renderAccount(); workspace.refresh(); });
  workspace.onState(renderAccount);
  auth.onChange(renderAccount);
  renderAccount();
  // (Not where a session is being joined: that asks, before it is.)
  if (!identity.welcomed() && !/^#room=/.test(location.hash)) setTimeout(() => { if (!identity.welcomed()) openCard(true); }, ASK_AFTER);
}

export function renderAccount() {
  const box = $("account");
  if (!box) return;
  const p = meAsShown();
  box.innerHTML = `${badgeOf(p)}<span class="aname">${esc(p.name)}</span><span class="acaret">▾</span>`;
  box.title = `You, as others see you${identity.said() ? "" : " (a guest: click to say who you are)"}`;
  box.classList.toggle("guest", !identity.said());
}

/** The card that says who this person is to others, and changes it. `first`: they have not been asked before. */
export function openCard(first = false) {
  $("accountCard")?.remove();
  const card = el("div", { id: "accountCard", class: "acard", role: "dialog", "aria-label": "Your name and picture" });
  let picked; // undefined: as it is; null: none of their own; a File: this one
  const preview = () => {
    const name = card.querySelector("[data-a=name]").value.trim() || identity.name();
    const picture = picked === undefined ? identity.picture() : picked ? URL.createObjectURL(picked) : auth.login() ? `https://avatars.githubusercontent.com/${encodeURIComponent(auth.login())}?s=88` : null;
    card.querySelector(".apreview").innerHTML = badgeOf({ ...meAsShown(), name, picture });
    card.querySelector("[data-a=clear]").hidden = picked === null || (picked === undefined && !identity.ownPicture());
  };
  const github = auth.can() && !auth.signedIn();
  card.innerHTML = `<h3>${first ? "Welcome! Who are you?" : "How others see you"}</h3>
    <p class="muted">In a session, others see this name and picture, and what you save is signed with the name. It is kept in this browser.</p>
    ${github ? `<button data-a="github" class="gsignin" title="Goes to GitHub, and comes back here">Sign in with GitHub</button><div class="aor muted">or</div>` : ""}
    <label>Your name <input data-a="name" maxlength="40" autocomplete="nickname" spellcheck="false" value="${esc(workspace.myName() ?? "")}" placeholder="${esc(identity.name())}"></label>
    <div class="apic"><span class="apreview"></span><button data-a="choose">Choose a picture…</button>${auth.login() ? `<button data-a="clear" title="Show your picture on GitHub instead">Use GitHub's picture</button>` : `<button data-a="clear" title="Show the creature of your name instead">Use the creature</button>`}<input data-a="file" type="file" accept="image/*" hidden></div>
    ${reportingBox()}
    <div class="aact"><button data-a="later">${first ? "Not now" : "Cancel"}</button><button data-a="done" class="primary">Done</button></div>`;
  document.body.append(card);
  // (Under the button, as the header settles and the window changes.)
  const place = () => {
    const at = $("account")?.getBoundingClientRect();
    if (at) { card.style.top = `${at.bottom + 6}px`; card.style.right = `${Math.max(8, window.innerWidth - at.right)}px`; }
  };
  const moved = new ResizeObserver(place);
  moved.observe(document.querySelector("header"));
  window.addEventListener("resize", place);
  place();
  // (A press elsewhere shuts it, as "Not now" or "Cancel" would.)
  const away = closeOnAway(card, () => close(), [$("account")]);
  const close = () => { identity.setWelcomed(); away(); moved.disconnect(); window.removeEventListener("resize", place); card.remove(); };
  const input = card.querySelector("[data-a=name]"), file = card.querySelector("[data-a=file]");
  input.oninput = preview;
  card.querySelector("[data-a=report]").onchange = (e) => setReporting(e.target.checked);
  file.onchange = () => { if (file.files[0]) { picked = file.files[0]; preview(); } };
  card.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
    if (e.key === "Enter" && e.target === input) card.querySelector("[data-a=done]").click();
  };
  card.onclick = async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "github") { identity.setWelcomed(); return auth.signIn(); }
    if (a === "choose") return file.click();
    if (a === "clear") { picked = null; return preview(); }
    if (a === "later") return close();
    if (a !== "done") return;
    const name = input.value.trim();
    if (name !== (workspace.myName() ?? "")) identity.setName(name);
    if (picked !== undefined) await identity.setPicture(picked).catch((err) => alert(`That picture could not be read: ${err.message ?? err}`));
    close();
  };
  preview();
  if (!first) input.focus();
}
