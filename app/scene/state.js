// What the scene's modules share: the workspace's state as last said, the 3D views, and what is
// chosen. Whoever changes one of these does it here; the rest
// read them as they are.

import { EMPTY, workspace } from "../workspace.js";

/**
 * The workspace's state (workspace.js), as last said; till it has said anything, one with nothing in it. The
 * model's parts are drawn, and can be chosen, before a workspace that a service keeps has said its first word
 * (which may be some seconds): whoever reads this then finds no issues, no planes, nobody, and not nothing at all.
 */
export let st = EMPTY;
export function setState(s) {
  st = s;
}

/** Whether the model has point clouds (their points, and what they say); whether its workspace is shared (others, issues, readings). */
export const hasPoints = () => workspace.can("points"), shared = () => workspace.can("shared");
/** Whether issues can be raised and worked here (a service's, or GitHub's). */
export const raising = () => workspace.can("issues");

/** The 3D views that are open, by id, of the root part focused: a GLView each (views.js: with `slab`, the id of the slab it is clipped to,
 *  `root`, the id of the root part it shows, and what else a view has). What the scene draws of a model, over its bodies (marks,
 *  handles, what is chosen, the points), is of the focused one, and drawn in these. */
export const views = {};
/** Every 3D view that is open, by id, whichever root part it shows: each draws its own root part's bodies, and the others in a session
 *  who are at it. */
export const allViews = {};
/** The views are of another root part focused (by its id): `views` are those of it. */
export function viewsOf(entry) {
  for (const id of Object.keys(views)) delete views[id];
  for (const [id, v] of Object.entries(allViews)) if (v.root === entry) views[id] = v;
}
/** The view last used (its id; none: none is open): what a link or a "go to" is shown in. Always one of `views`. */
export let active = null;
export const setActive = (id) => { active = id; };

/**
 * What is chosen: one of `pick` (a point: what a ray met), `member` (a part's path; `at`: where on it), `selection`,
 * `plane`, `slab`, `polyline` (ids): see chosen.js. And beside it: the `issue` open, the `proposal` shown
 * ({ issue, n, commit, mode }), the part under the cursor (`hover`), parts to `highlight`, who is chatted with.
 */
export const sel = { issue: null, proposal: null, pick: null, filter: "all", done: false, drafting: false };
/** A slab or polyline as it is dragged, ahead of the workspace's state: { kind, id, value, done (the workspace has been told) }. */
export let live = null;
export const setLive = (value) => (live = value);

/**
 * What an issue's place is pinned to: { kind, id } (a part of the model, a selection, a plane, a slab, a
 * polyline), or null. (A service that says it the way it was once kept, a field for each kind, is read too.)
 */
/** Whether a place is of the part this page is of: an issue is the repository's, and where it is, is one part's. (An older one's says nothing: of whichever is open.) */
/** Whether a place is of the part the page is of: a place names its part by its path in the workspace (docs/workspaces.md). */
export const placedHere = (place) => !!place && (!place.part || place.part === st?.workspace?.model);
export const pinOf = (place) => place?.on ?? (place?.member ? { kind: "member", id: place.member } : place?.selection ? { kind: "selection", id: place.selection } : place?.plane ? { kind: "plane", id: place.plane } : place?.object ? { kind: place.object[0] === "b" ? "slab" : "polyline", id: place.object } : null);
/** The id of what a place is pinned to, where that is of this kind. */
export const pinnedTo = (place, kind) => { const on = pinOf(place); return on?.kind === kind ? on.id : null; };

export const f3 = (p) => `[${p.map((x) => x.toFixed(2)).join(", ")}]`;
export const round = (p, k = 1000) => p.map((x) => Math.round(x * k) / k);
/** A part's path, short: its group and its name. */
export const shortPath = (p) => p.split("/").slice(-2).join("/");
