// A project on GitHub's issues are GitHub's: real issues, which anyone with an account can raise on a public repository, whether or not they can push.
// As the workspace has them (scene/issues.js): the same shape as a host's (crates/fettled-workspace/src/issues.rs), so the page is the same over either. What
// GitHub has no field for, what an issue is pinned to and the view attached, goes in the body as a comment, which GitHub does not show.
//
// A proposal is what it is on a host: a branch (`proposals/<issue>-<n>`), which taking it merges. It is said in its issue by being there: nothing needs writing
// in the issue, so it takes no more than being able to push. Rejected, it stays, as `proposals/rejected/…`.
//
// Raising one goes by the API where the person's token may. Where it may not, or there is none, it goes by GitHub's own form, filled in: that takes nothing
// of the App, and anyone with an account can use it.

import { pathIn } from "./ids.js";
import { merger } from "./merge.js";

const MARK = /\n*<!-- fettled (\{.*?\}) -->\s*$/s;
/** How often they are looked at again, while the page is looked at. */
const LOOK_EVERY = 60000;
/** How far back the branch's history is read for what has been reverted. */
const HISTORY = 100;

/** What took a commit back and still stands: not one that was itself reverted. `reverts`: each commit, and the latest that says it reverts it. */
const standing = (reverts, sha) => { const by = reverts.get(sha); return by && !standing(reverts, by) ? by : null; };
/** What a history (the latest first) says was reverted, and what merged what. */
function asHistory(log) {
  const reverts = new Map(), merges = new Map();
  for (const c of log) {
    for (const [, of] of c.message.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) if (!reverts.has(of)) reverts.set(of, c.sha);
    if (c.parents.length > 1) for (const p of c.parents.slice(1)) merges.set(p, c.sha);
  }
  return { reverts, merges };
}

/** A body, with what the app keeps in it and GitHub does not show; a view, as a link anyone can follow, is shown too. */
export function bodyOf(text, { place, view, viewLabel, viewUrl } = {}) {
  const link = viewUrl ? `\n\n[${viewLabel ? `Open in fettled: ${viewLabel}` : "Open in fettled"}](${viewUrl})` : "";
  const kept = { ...(place ? { place } : {}), ...(view ? { view, view_label: viewLabel } : {}) };
  return `${text ?? ""}${link}${Object.keys(kept).length ? `\n\n<!-- fettled ${JSON.stringify(kept).replaceAll("--", "\\u002d\\u002d")} -->` : ""}`.trim();
}
/** What a body says, and what the app kept in it. (A view's link is the app's too: it is there as the view, for whoever opens it here.) */
export function parseBody(body) {
  const m = MARK.exec(body ?? "");
  let kept = {};
  try { kept = m ? JSON.parse(m[1]) : {}; } catch (_) { /* someone has edited it: as if it had none */ }
  return { text: (m ? body.slice(0, m.index) : body ?? "").replace(/\n*\[Open in fettled[^\]]*\]\([^)]*\)\s*$/, "").trim(), ...kept };
}

const timeOf = (iso) => new Date(iso).getTime() / 1000;

/** An issue of GitHub's as the page has them. */
function asIssue(g, comments) {
  const { text, place, view, view_label } = parseBody(g.body);
  const first = { who: g.user?.login ?? "someone", time: timeOf(g.created_at), kind: "comment", text, ...(view ? { view, view_label } : {}) };
  const rest = comments.map((c) => { const k = parseBody(c.body); return { who: c.user?.login ?? "someone", time: timeOf(c.created_at), kind: "comment", text: k.text, ...(k.view ? { view: k.view, view_label: k.view_label } : {}) }; });
  return { id: g.number, title: g.title, category: place ? "scan" : "note", status: g.state === "closed" ? "done" : "open", priority: 2, rank: timeOf(g.created_at), by: first.who, time: first.time, ...(place ? { place } : {}), entries: [...(text || view ? [first] : []), ...rest], updated: g.updated_at, url: g.html_url };
}

export class GitHubIssues {
  /** `git`: the repository (github.js). `work`: the project on its branch (work.js). `tool(args)`: the git tool. `root`: the part the page is of, which a place is of. `said()`: they have changed. `viewUrl(view)`: a link to a view. `open(url)`: GitHub's form, for a person to finish. */
  constructor({ git, work, tool, root, said, viewUrl, open = (url) => globalThis.open?.(url, "_blank", "noopener") }) {
    Object.assign(this, { git, work, tool, root, said, viewUrl, open });
    this.list = [];
    /** What each proposal's commit was read as: sha → `{ title, author, time, files }`; and whether it is in the branch where it was looked at. */
    this.commits = new Map();
    this.merged = new Map();
    /** What each was last read as: number → the issue. */
    this.read = new Map();
  }
  async load() {
    const raw = await this.git.issues();
    const list = await Promise.all(raw.map(async (g) => {
      const had = this.read.get(g.number);
      if (had?.updated === g.updated_at) return had;
      const issue = asIssue(g, g.comments ? await this.git.issueComments(g.number) : []);
      this.read.set(g.number, issue);
      return issue;
    }));
    const proposals = await this.proposals().catch((e) => { console.warn("proposals:", e.message ?? e); return new Map(); });
    const withThem = list.map((i) => (proposals.has(i.id) ? { ...i, entries: [...i.entries, ...proposals.get(i.id)].sort((a, b) => a.time - b.time) } : i));
    const changed = JSON.stringify(withThem) !== JSON.stringify(this.list);
    this.list = withThem;
    if (changed) this.said();
  }
  /** The files a commit changed from its first parent. */
  async changedBy(sha) {
    const { parents } = await this.git.commitOf(sha), [was, now] = await Promise.all([parents[0] ? this.git.files(parents[0]) : { files: new Map() }, this.git.files(sha)]);
    return [...new Set([...was.files.keys(), ...now.files.keys()])].filter((p) => was.files.get(p) !== now.files.get(p));
  }
  /** The proposals there are, as entries of the issues they are of: issue → entries. */
  async proposals() {
    const out = new Map(), head = this.work.base.head ?? this.work.base.at?.commit;
    // (Read once for each place the branch is at: the proposals are looked at every minute, and it rarely moves.)
    if (head && this.history?.head !== head) this.history = { head, ...asHistory(await this.git.log(head, HISTORY)) };
    for (const { name, sha } of await this.git.branchesUnder("proposals/")) {
      const m = /^proposals\/(rejected\/)?(\d+)-(\d+)$/.exec(name);
      if (!m) continue;
      if (!this.commits.has(sha)) {
        const [c] = await this.git.log(sha, 1);
        this.commits.set(sha, { title: c.message.split("\n")[0], who: c.author, time: new Date(c.date).getTime() / 1000, files: await this.changedBy(sha) });
      }
      const key = `${sha}|${head}`;
      if (!m[1] && !this.merged.has(key)) this.merged.set(key, head ? (await this.git.compare(sha, head)).ahead === 0 : false);
      const c = this.commits.get(sha), applied_as = !m[1] && this.merged.get(key) ? this.history?.merges.get(sha) ?? sha : null;
      const reverted_by = applied_as && this.history ? standing(this.history.reverts, applied_as) ?? standing(this.history.reverts, sha) : null;
      const state = m[1] ? "rejected" : reverted_by ? "reverted" : applied_as ? "applied" : "open";
      const entry = { kind: "proposal", n: Number(m[3]), who: c.who, time: c.time, title: c.title, commit: sha, branch: name, files: c.files, members_added: [], members_removed: [], state, applied_as, reverted_by };
      out.set(Number(m[2]), [...(out.get(Number(m[2])) ?? []), entry]);
    }
    return out;
  }
  entryOf(issue, n) {
    return this.list.find((i) => i.id === issue)?.entries.find((e) => e.kind === "proposal" && e.n === n) ?? null;
  }
  /** As a workspace's `proposal` tool: its text, or taken, rejected, or taken back. */
  async proposal({ issue, n, action = "diff" }) {
    const e = this.entryOf(issue, n), said = (text) => ({ text, images: [] });
    try {
      if (!e) throw new Error(`no proposal ${n} of issue #${issue}`);
      if (action === "diff") {
        const { parents } = await this.git.commitOf(e.commit), lib = await merger();
        const texts = await Promise.all(e.files.map(async (p) => lib.unified(p, (await this.git.textAt(parents[0], p)) ?? "", (await this.git.textAt(e.commit, p)) ?? "")));
        return said(texts.join(""));
      }
      let r;
      if (action === "apply") {
        // (Reverted, git has it already: what is taken back is what took it back.)
        if (e.state === "open") r = await this.tool({ action: "merge", name: e.branch, message: `Proposal ${n} of issue #${issue}: ${e.title}`, noFf: true });
        else if (e.state === "reverted") r = await this.tool({ action: "revert", commit: e.reverted_by });
        else throw new Error(`proposal ${n} is ${e.state}, not open`);
        if (r.data?.clashed) return { error: `it clashes with what the branch has since: settle ${r.data.clashed.join(", ")} in Changes`, text: "", images: [] };
      } else if (action === "reject") {
        if (e.state !== "open") throw new Error(`proposal ${n} is ${e.state}, not open`);
        await this.git.branch(e.branch.replace("proposals/", "proposals/rejected/"), e.commit);
        await this.git.deleteBranch(e.branch);
        r = {};
      } else if (action === "revert") {
        if (e.state !== "applied") throw new Error(`proposal ${n} is ${e.state}, not applied`);
        r = await this.tool({ action: "revert", commit: e.applied_as });
      } else throw new Error(`action: diff, apply, reject or revert (not ${action})`);
      if (r.error) return { error: r.error, text: "", images: [] };
      await this.load();
      return said(`proposal ${n}: ${{ apply: "applied", reject: "rejected", revert: "reverted" }[action]}`);
    } catch (err) {
      return { error: this.git.explain(err), text: "", images: [] };
    }
  }
  /** A proposal as the views show it (scene/proposals.js): built here, from its files over the model as it is. */
  async diff(commit) {
    const e = this.list.flatMap((i) => i.entries).find((x) => x.kind === "proposal" && x.commit === commit);
    if (!e) return { error: "no such proposal here" };
    const after = {};
    // (By their paths in the workspace, as a host's are: scene/proposals.js names them in it.)
    for (const p of e.files) { const t = await this.git.textAt(commit, p); if (t != null) after[pathIn(p)] = t; }
    const taking = e.state === "open" || e.state === "reverted";
    return { before: [], after: [], changes: {}, files: { after }, model_rev: 0, offer: { state: e.state, label: e.state, action: taking ? "apply" : e.state === "applied" ? "revert" : null, enabled: true, before: "As it is", after: taking ? "With it" : "As proposed" } };
  }
  /** Reads them, and again now and then. */
  start() {
    this.load().catch((e) => console.warn("issues:", e.message ?? e));
    setInterval(() => { if (!document.hidden) this.load().catch(() => {}); }, LOOK_EVERY);
  }
  /** What is pinned to, as the page says it (`scene/issues.js`): a point, or a thing. */
  placeOf({ point, on }) {
    return point ? { min: point, max: point, part: this.root } : on ? { min: [0, 0, 0], max: [0, 0, 0], on, part: this.root } : null;
  }
  /** As a workspace's `issues` tool: `{ text }`, or `{ error }`. */
  async call(args) {
    const said = (text) => ({ text, images: [] });
    try {
      if (args.action === "create") return await this.create(args);
      if (args.action === "comment") return await this.comment(args);
      if (args.action === "update") return await this.update(args);
      if (args.action === "list" || !args.action) return said(this.list.map((i) => `#${i.id} ${i.title}`).join("\n"));
      return { error: `issues on GitHub are ${args.action === "delete" ? "deleted" : "changed that way"} on GitHub`, text: "", images: [] };
    } catch (e) {
      return { error: String(e.message ?? e), text: "", images: [] };
    }
  }
  async create({ title, text, point, on, view, view_label }) {
    const viewUrl = view ? await this.viewUrl(view) : null, place = this.placeOf({ point, on });
    const body = bodyOf(text, { place, view, viewLabel: view_label, viewUrl });
    const made = await this.git.newIssue({ title, body }).catch(() => null);
    if (made) {
      await this.load();
      return { text: `raised #${made.number}`, images: [] };
    }
    this.open(this.git.newIssueForm({ title, body }));
    return { text: "GitHub's form is open, filled in: raise it there", images: [] };
  }
  async comment({ id, text, view, view_label }) {
    const viewUrl = view ? await this.viewUrl(view) : null;
    const body = bodyOf(text, { view, viewLabel: view_label, viewUrl });
    const made = await this.git.issueComment(id, body).catch(() => null);
    if (made) {
      await this.load();
      return { text: `said in #${id}`, images: [] };
    }
    // (A form takes a new issue's text, and not a comment's: it is there to paste.)
    await navigator.clipboard?.writeText(body).catch(() => {});
    this.open(this.read.get(id)?.url ?? this.git.issueUrl(id));
    return { text: `#${id} is open on GitHub, and what you wrote is on your clipboard, to paste there`, images: [] };
  }
  async update({ id, status, title }) {
    const change = { ...(title ? { title } : {}), ...(status ? { state: status === "done" ? "closed" : "open" } : {}) };
    if (!Object.keys(change).length) return { error: "on GitHub, an issue has a title and is open or closed: the rest is not kept", text: "", images: [] };
    const made = await this.git.setIssue(id, change).catch(() => null);
    if (!made) {
      this.open(this.read.get(id)?.url ?? this.git.issueUrl(id));
      return { text: `you may not change #${id} from here: it is open on GitHub`, images: [] };
    }
    await this.load();
    return { text: `#${id} changed`, images: [] };
  }
}
