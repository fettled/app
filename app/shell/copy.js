// A built-in workspace (the examples; a published site's files) is read-only: it is changed in a copy of one's own, made
// here, in a place that keeps workspaces (this browser; a host that makes them), and then gone to. Said over the page of
// one, with the edits this browser kept over it from before it was read-only, which are copied with it or let go of.

import { $, el, esc } from "../ui.js";
import { idOf, pathIn, workspaceOf } from "../ids.js";
import { isBuiltin, project, storage } from "../project.js";
import { leaving } from "./projects.js";
import { shareMenu } from "../share-menu.js";

/** The places a copy can be made in, as they can be now: `[{ kind, label, note }]`. */
function places() {
  const out = [{ kind: "browser", label: "Browser storage", note: "kept in this browser, on this computer" }];
  if (project.makesWorkspaces("host")) out.push({ kind: "host", label: "Host server", note: `a git repository on ${storage.site.label}` });
  return out;
}

/**
 * Asks where, and by what name, a workspace (`workspace`, in location `kind`) is copied; copies it, and goes to the copy (at
 * `part`'s path in it, where one is said; else its own model). `why`: said first. `edits`: how many files this browser kept
 * edited over it, copied with it and then let go of.
 */
export function copyWorkspace({ kind, workspace, part = null, why = "", edits = 0 }) {
  const d = el("dialog", { class: "joinsession copyto" });
  const at = places();
  d.innerHTML = `<form method="dialog">
    <h3>Copy ${esc(workspace)} to change it</h3>
    <p>${why ? `${esc(why)} ` : ""}A copy is a workspace of your own, kept where you choose; ${esc(workspace)} itself stays as it is.${edits ? ` The ${edits} file${edits === 1 ? "" : "s"} edited here before go with it, and are then let go of here.` : ""}</p>
    <label>Name <input data-c="name" value="${esc(workspace)}" spellcheck="false" autocomplete="off" required></label>
    <div class="cwhere">${at.map((p, k) => `<label class="cplace"><input type="radio" name="to" value="${p.kind}"${k === 0 ? " checked" : ""}><span><b>${esc(p.label)}</b> <span class="muted">${esc(p.note)}</span></span></label>`).join("")}</div>
    <p class="cerr" hidden></p>
    <div class="jbuttons"><button value="copy" class="primary">Copy</button><button value="cancel" formnovalidate>Cancel</button></div>
  </form>`;
  document.body.append(d);
  const err = d.querySelector(".cerr"), name = d.querySelector("[data-c=name]");
  d.addEventListener("close", () => d.remove());
  d.querySelector("form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "copy") return;
    e.preventDefault();
    const to = d.querySelector("input[name=to]:checked").value, button = e.submitter;
    button.disabled = true;
    button.textContent = "Copying…";
    err.hidden = true;
    const r = await project.copyWorkspace(kind, workspace, name.value, to);
    if (r.error) {
      err.textContent = `It was not copied: ${r.error}`;
      err.hidden = false;
      button.disabled = false;
      button.textContent = "Copy";
      return;
    }
    if (edits) await project.discardEdits(kind, workspace);
    if (r.skipped.length) alert(`Copied, but for ${r.skipped.length} file${r.skipped.length === 1 ? "" : "s"} that are not text (pictures, scans), which stay only in ${workspace}:\n\n${r.skipped.slice(0, 20).join("\n")}${r.skipped.length > 20 ? "\n…" : ""}`);
    d.close();
    if (!leaving()) return;
    // (Where it was of a part, at that part in the copy; else its own model, where it has one; else the workspaces page.)
    const list = await project.listIn(to), parts = (list.projects ?? []).filter((p) => p.workspace === r.workspace);
    const target = parts.find((p) => p.path === idOf(r.workspace, pathIn(part ?? "")))?.path ?? parts.find((p) => p.path === idOf(r.workspace, "model.ts"))?.path ?? parts[0]?.path;
    if (target) await project.go(target, to);
  });
  d.showModal();
  name.select();
}

/** Over the page of a built-in workspace: that it is read-only, a way to copy it, and the edits kept over it from before. */
export async function readOnlyBar() {
  const home = project.home();
  if (!home || !storage.store?.readOnly || !isBuiltin(storage.kind)) return null;
  const workspace = workspaceOf(home), edits = (await project.editsIn(storage.kind, workspace)).length;
  const bar = el("div", { class: "robar" });
  bar.innerHTML = `<span><b>${esc(workspace)}</b> is built-in, and read-only. To change it, copy it to a place of your own.</span><button data-c="copy" class="primary">Copy to…</button>${edits ? `<span class="roedits">${edits} file${edits === 1 ? " was" : "s were"} edited here before:</span><button data-c="save">Save as a copy</button><button data-c="discard">Discard</button>` : ""}`;
  bar.onclick = async (e) => {
    const c = e.target.closest("[data-c]")?.dataset.c;
    if (c === "copy") copyWorkspace({ kind: storage.kind, workspace, part: project.current() });
    if (c === "save") copyWorkspace({ kind: storage.kind, workspace, part: project.current(), edits });
    if (c === "discard" && confirm(`Let go of the ${edits} file${edits === 1 ? "" : "s"} edited here? ${workspace} is then as it is built-in.`)) {
      await project.discardEdits(storage.kind, workspace);
      await project.touched();
      showReadOnly();
    }
  };
  return bar;
}
/** Shows it, over the page (where the page is of a built-in workspace), in place of what it said before. */
export async function showReadOnly() {
  const bar = await readOnlyBar();
  $("readOnly").replaceChildren(...(bar ? [bar] : []));
  $("readOnly").hidden = !bar;
}

/** The header's Share, on a built-in workspace: it is shared as a copy of one's own (a session changes what it is of). */
export function offerCopyToShare() {
  const workspace = workspaceOf(project.home());
  shareMenu({
    label: "Share ▾",
    title: "A built-in workspace is read-only: copy it to work on it with others",
    items: () => [
      { label: `${workspace} is built-in and read-only`, cls: "head" },
      { label: "Copy it to share it…", run: () => copyWorkspace({ kind: storage.kind, workspace, part: project.current(), why: "A session changes what it is of, so it is of a copy." }) },
    ],
  });
}
