// What of the model the page shows beyond its parts (the filter at the top of the tree): its fastenings, each nail its
// nailings lay out and each hanger with its nails, as parts under the part that says them. Off unless asked for: a house has thousands. Kept in
// this browser; whoever shows the model is told when it changes.

import { stored, store } from "./ui.js";

const KEY = "fettled.filters";
let shown = { fixings: false, ...stored(KEY, {}) };
const told = new Set();

/** Whether its fastenings are shown. */
export const showsFixings = () => !!shown.fixings;

/** Its fastenings shown, or not. */
export function showFixings(yes) {
  if (!!yes === showsFixings()) return;
  shown = { ...shown, fixings: !!yes };
  store(KEY, shown);
  for (const f of told) f();
}

/** Tells `f` whenever what is shown changes. */
export function onFilters(f) {
  told.add(f);
}
