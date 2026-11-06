// The Share menu, in the header: how a session on the project is begun (none of a session's own code is loaded till it is), and, in one
// (session/enter.js), how others are asked in and how to leave. What it offers is what the project's versions say they can do (work.js).

import { $, openMenu } from "./ui.js";
import { msg } from "./shell/panel.js";

let button = null;

/** The header's Share button: `label` on it (or `html`), and `items()` what it opens to, as a menu has them. In place of what was there.
 *  (Its place in the header is kept for it, beside who is here: nothing moves as it comes.) */
export function shareMenu({ label, html, cls = "act", title = "", items }) {
  button ??= $("shareMenu");
  button.hidden = false;
  button.className = cls;
  if (html) button.innerHTML = html;
  else button.textContent = label;
  button.title = title;
  button.onclick = async () => {
    const r = button.getBoundingClientRect();
    openMenu(await items(), r.left, r.bottom);
  };
}

/** Begins a session, and the page goes to it: said if it cannot. */
async function start(overInternet) {
  const enter = await import("./session/enter.js");
  if (!(await enter.askToJoin())) return;
  const was = button.textContent;
  button.textContent = "Starting…";
  button.disabled = true;
  try {
    await enter.startSession({ overInternet });
  } catch (e) {
    // (What only says it failed, said of what: and sent where it may be, so that it need not be copied out.)
    const { report, unreached } = await import("./report.js");
    const what = /failed to fetch|load failed|networkerror/i.test(String(e.message ?? e)) ? unreached() : null;
    const id = await report("start", e, { overInternet });
    msg(`${e.message ?? e}${what ? ` (${what})` : ""}${id ? ` This was reported (${id}).` : ""}`, true);
    button.textContent = was;
    button.disabled = false;
  }
}

/** What is said before a project's repository is shared over the internet. */
const warning = (repo) => `Anyone with the invite link can read everything in ${repo} that this host serves: every project, every branch and all its history, for as long as this is shared. It goes through a relay that cannot read it.\n\nThey can change what is in the session. Only you can commit it.\n\nShare it?`;

/** Of a project with versions, not in a session: a session offered, as far as those can have one. */
export function offerSessions(work) {
  shareMenu({
    label: "Share ▾",
    title: "Work on this with others, live: everyone in a session sees the same model and each other",
    async items() {
      const s = await work.status(), can = (a) => s.can.includes(a);
      if (s.viewing || s.merging || s.conflicts.length) return [{ label: "Finish what is in progress in Changes to begin a session", cls: "head" }];
      if (!can("session")) return [{ label: work.whyNot("session"), cls: "head" }];
      // (Where a session's room can be in more than one place, each is named. On a branch of a repository elsewhere it is always on the relay.)
      if (!can("share")) return [{ label: "Start a session", run: () => start(false) }];
      return [
        { label: "Session on this server", title: "Its room is on this server: those who can reach this server can join", run: () => start(false) },
        { label: "Session via relay…", title: "Anyone with the link can join, from anywhere. Your files stay on this machine, and the room is on a relay that can't read them", run: () => { if (confirm(warning(s.repo))) start(true); } },
      ];
    },
  });
}
