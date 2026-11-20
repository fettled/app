// Spaces: named boxes in the model's frame (a room, a garage bay, a yard, a garden), kept with the project (people and agents name
// them); drawn in the views, and counted in the tree (kinds.js).

import { vis } from "../objects.js";
import { st } from "./state.js";
import { corners } from "./geom.js";
import { kind } from "./kinds.js";

kind("space", {
  group: "spaces", order: 70,
  rows: (row) => (st.spaces.length ? row(0, "top", "spaces", "Spaces", { note: st.spaces.length }) : ""),
  marks(out) {
    if (vis("spaces")) for (const r of st.spaces) out.box(corners(r), [120, 170, 255]);
  },
});
