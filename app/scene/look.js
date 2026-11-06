// How a 3D view looks, apart from where it looks from: everything a person can change of what it shows, as one record
// (`lookOf`), and given to a view as a whole (`setLook`). What follows someone takes it (together.js), so whatever is
// added to how a view looks is added here, or it is not seen by those following.
//
// What is hidden is the page's, not the view's, and is given with `objects.borrow`, to be given back: `setLook` leaves it.
// What is chosen is the page's too, but is given as the rest is (choosing it, not said as done here).

import * as objects from "../objects.js";
import { applyVisibility, renderTools } from "./views.js";
import { slabOf, syncSlabs, tempSlab } from "./slabs.js";
import { displayExact, sectionExact } from "./exact.js";
import { viewPhoto } from "./photos.js";
import { balanceFrom, balanceOf, markBalance, marksBalance } from "./parts.js";
import { drawOverlay, shapeOver } from "./overlay.js";
import { choose, chosen } from "./chosen.js";

/** What of the view's own state (glview.js) is how it looks: not where its camera is, nor its box (the slab's). */
const SCENE = ["colour", "doubt", "free", "paper", "pointSize", "tint"];

/** All of how a view looks now. */
export function lookOf(v) {
  const s = slabOf(v.slab), st = v.state;
  return {
    hidden: [...objects.hidden],
    slab: s ? { id: s.temp ? null : s.id, centre: s.centre, axes: s.axes, half: s.half, filter: !!s.filter, ...(s.cuts ? { cuts: s.cuts } : {}) } : null,
    display: v.display ? { ...v.display } : null,
    section: v.section ?? null,
    skeleton: !!v.skeleton,
    deflected: !!v.deflected,
    // (The middle of the weight marked, and of what: what is chosen.)
    balance: { on: marksBalance(), of: balanceOf() },
    photo: st.photo?.name ?? null,
    scene: Object.fromEntries(SCENE.map((k) => [k, st[k]])),
    // (What is chosen is the page's, as what is hidden is; but it is what is talked about, so it is seen.)
    chosen: chosenNow(),
  };
}

const chosenNow = () => { const c = chosen(); return c ? { kind: c.kind, id: c.id } : null; };

/** A view made to look as `look` says (as `lookOf` gives it), all but what is hidden; what is chosen, where it says. */
export function setLook(v, look) {
  if (look.slab) {
    // (One kept with the project is had here too; else one like it, not kept.)
    const kept = look.slab.id && slabOf(look.slab.id), s = kept || tempSlab({ centre: look.slab.centre, axes: look.slab.axes, half: look.slab.half });
    if (!kept) { s.filter = look.slab.filter; if (look.slab.cuts) s.cuts = look.slab.cuts; else delete s.cuts; }
    v.slab = s.id;
  } else v.slab = null;
  syncSlabs();
  if (look.display) { v.display = { ...look.display }; displayExact(v); }
  if (JSON.stringify(v.section ?? null) !== JSON.stringify(look.section ?? null)) sectionExact(v, look.section ?? false);
  v.skeleton = !!look.skeleton;
  v.deflected = !!look.deflected;
  // (Of what it says, or, saying nothing of what, of what is chosen here.)
  if (look.balance) { balanceFrom(look.balance.of ?? null); if (look.balance.on !== marksBalance()) markBalance(look.balance.on, false); }
  if (look.photo) { if (v.state.photo?.name !== look.photo) viewPhoto(look.photo, v); }
  else if (v.state.photo) { v.set({ photo: null }); v.onPhotoGone?.(); }
  if (look.scene) v.set(look.scene, true);
  if ("chosen" in look && JSON.stringify(look.chosen) !== JSON.stringify(chosenNow())) choose(look.chosen?.kind ?? null, look.chosen?.id ?? null, false);
  drawOverlay(v);
  shapeOver();
  applyVisibility();
  renderTools(v);
}
