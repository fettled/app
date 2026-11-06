// A file's id, everywhere the page has one (docs/workspaces.md): `WORKSPACE:PATH`, its workspace's name, a colon, and its path
// in the workspace (`/`-separated, nothing above it). A workspace is a folder with history (a git repository), or a folder by
// itself; its name has no `/` and no `:`. Whatever takes an id apart does it here: nothing else splits one on `/`.

/** What a workspace's name may be. */
export const WORKSPACE_NAME = /^[A-Za-z0-9._-]+$/;

/** The workspace an id is of (null: none, which no id the page has should be). */
export function workspaceOf(id) {
  const i = id?.indexOf(":") ?? -1;
  return i > 0 && !id.slice(0, i).includes("/") ? id.slice(0, i) : null;
}
/** The file's path in its workspace. */
export const pathIn = (id) => {
  const w = workspaceOf(id);
  return w == null ? id : id.slice(w.length + 1);
};
/** The id of a file at a path in a workspace. */
export const idOf = (workspace, path) => `${workspace}:${path}`;
/** The folder an id is in, as the start of the ids in it: `w:a/b.ts` → `w:a`; `w:b.ts` → `w:` (the workspace itself). */
export function dirOf(id) {
  const w = workspaceOf(id), p = pathIn(id), i = p.lastIndexOf("/"), d = i < 0 ? "" : p.slice(0, i);
  return w == null ? d : d ? `${w}:${d}` : `${w}:`;
}
/** A name in a folder (as `dirOf` has it). */
export const inDir = (dir, name) => (!dir ? name : dir.endsWith(":") ? dir + name : `${dir}/${name}`);
/** Whether a file is in a folder (as `dirOf` has it), at any depth. */
export const within = (id, dir) => !dir || id.startsWith(dir.endsWith(":") ? dir : `${dir}/`);
/** A file's name: the last of its path. */
export const nameOf = (id) => pathIn(id).split("/").pop();
/** The start of every id in a workspace. */
export const homeOf = (id) => {
  const w = workspaceOf(id);
  return w == null ? "" : `${w}:`;
};
/** A path as a workspace has it: within it, `..` and `.` gone; null where it would be above it. */
export function normalPath(path) {
  const out = [];
  for (const p of path.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!out.length) return null; out.pop(); } else out.push(p);
  }
  return out.join("/");
}
/** A file's id beside another's, by a relative path (`./x`, `../x`, `x`); null where that is above the workspace. */
export function beside(id, rel) {
  const p = normalPath(`${pathIn(dirOf(id).replace(/:$/, ":."))}/${rel}`);
  return p == null ? null : idOf(workspaceOf(id), p);
}
/** A workspace's name for a folder or repository of this name: what a name may have, the rest `-`. */
export const workspaceName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
