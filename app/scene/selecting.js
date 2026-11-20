// What a view picks, as a selection (docs/points-and-selections-plan.md; fettled_part::select): a click is a ray from the
// view's camera through its pixel, a drag an outline of its picture. The workspace finds what each picks, as it does an
// agent's (`select`): one way to pick, whoever picks.
//
// A view's camera is said explicitly: through a photo, the photo's part (its own lens, as it is found); else the view's
// pose in the model's frame and its lens (a pinhole, or seen parallel), as they are now, so that what was picked through
// it is what it picks later, however the view is set to look by then. Lengths in mm, the model's frame.

import { workspace } from "../workspace.js";

import { photoNamed } from "./photos.js";
import { hiddenBodyAddresses } from "./exact.js";
import { hiddenPointParts } from "./points.js";
import { slabOf } from "./slabs.js";

const mm = (p) => p.map((x) => x * 1000);
const neg = (v) => v.map((x) => -x);

/** A view's camera as a selection says one, and how a canvas position (CSS pixels) is a pixel of its picture. Null where
 *  the view draws nothing yet. */
export function cameraOf(v) {
  // (A view not on the page has no size: no camera.)
  const cam = v.canvas?.clientWidth && v.canvas?.clientHeight ? v.camera() : null;
  if (!cam) return null;
  if (cam.through) {
    const p = photoNamed(v.state.photo?.name);
    if (!p?.address) return null;
    return { camera: { frame: p.address }, pixel: (x, y) => v.pixel(cam, x, y) };
  }
  const axes = [cam.right, neg(cam.up), cam.forward];
  const centre = [cam.w / 2, cam.h / 2];
  // (A pinhole's focal length, in pixels, from its upright field of view; seen parallel, pixels to a mm.)
  const lens = cam.ortho ? { model: "parallel", numbers: [cam.h / 2 / (cam.hh * 1000), ...centre] } : { model: "pinhole", numbers: [cam.h / 2 / Math.tan(cam.fov / 2), ...centre] };
  return { camera: { frame: { of: "", origin: mm(cam.eye), axes }, lens, size: [cam.w, cam.h] }, pixel: (x, y) => [x, y] };
}

/** What is not drawn, by address: what a pick from a view does not meet. */
export const hiddenIn = () => [...hiddenBodyAddresses(), ...hiddenPointParts()];

/** What a ray from a view through a canvas position meets of `of` (points, parts, faces, edges, vertices): nearest first, or
 *  (`nearest`) only that. `[]` where the view draws nothing yet. */
export async function rayPick(v, x, y, of, { nearest = true, px = 4 } = {}) {
  const c = cameraOf(v);
  if (!c) return [];
  const selection = { of, where: { ray: { from: { in: c.camera, pixel: c.pixel(x, y) }, radius: { px } }, ...(nearest ? { nearest: true } : {}) } };
  const r = await workspace.select(selection, "", hiddenIn());
  return r.found ?? [];
}

/** A selection of the points a view shows inside a rectangle of its canvas (CSS pixels, two corners): everything in its
 *  cone, whatever is in front; in a view clipped to a slab, only what is in the slab. */
export function rectangleSelection(v, [x0, y0], [x1, y1]) {
  const c = cameraOf(v);
  if (!c) return null;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => c.pixel(x, y));
  const outline = { outline: { loops: [{ from: corners[0], runs: corners.slice(1).map((to) => ({ to })) }] }, in: c.camera };
  const slab = v.state.box && slabOf(v.slab);
  const where = slab && !slab.filter ? { intersection: [outline, { shape: { frame: "", centre: mm(slab.centre), axes: slab.axes, half: mm(slab.half) } }] } : outline;
  return { of: "points", where };
}
