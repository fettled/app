// A log as a graph: which lane each commit goes in, and what joins it to the next row. Nothing here knows how it is drawn, but `rowSvg` draws one row.

/** Of commits, newest first, each `{ sha, parents }`: for each, `{ col: its lane, before: lanes coming in, after: lanes going out (each what it is waiting
 *  for; null: free), to: the lanes its parents go on in }`. */
export function lanes(commits) {
  let active = [];
  const free = () => { const k = active.indexOf(null); return k < 0 ? active.length : k; };
  return commits.map((c) => {
    let col = active.indexOf(c.sha);
    if (col < 0) active[(col = free())] = c.sha;
    const before = [...active], merged = active.map((x, k) => (x === c.sha && k !== col ? k : -1)).filter((k) => k >= 0);
    // (Others waiting on this one end here: they joined it.)
    for (const k of merged) active[k] = null;
    active[col] = null;
    // (Its first parent goes on in its lane, though another lane waits for it too: they join there. The others, in a lane of their own, or one waiting for them.)
    const to = c.parents.map((p, n) => {
      let k = n === 0 ? col : active.indexOf(p);
      if (k < 0) k = free();
      active[k] = p;
      return k;
    });
    while (active.length && active.at(-1) === null) active.pop();
    return { col, before, after: [...active], to, merged };
  });
}

const COLOURS = ["#2f7fe8", "#2e9e5b", "#e8820c", "#b45bd6", "#0ea5a5", "#d6409f"];
const STEP = 12, HEIGHT = 22;

/** One row of it, as an SVG: its lanes, and a dot for the commit. */
export function rowSvg({ col, before, after, to, merged }) {
  const width = STEP * (Math.max(before.length, after.length, col + 1, ...to.map((k) => k + 1)) + 0.5), x = (k) => STEP * k + STEP / 2, mid = HEIGHT / 2, lines = [];
  const line = (x1, y1, x2, y2, k) => lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLOURS[k % COLOURS.length]}" stroke-width="1.5"/>`);
  // (Those going by; those that end at this commit; and from it to its parents.)
  before.forEach((sha, k) => { if (sha != null && k !== col && !merged.includes(k)) line(x(k), 0, x(k), HEIGHT, k); });
  for (const k of merged) line(x(k), 0, x(col), mid, k);
  if (before[col] != null) line(x(col), 0, x(col), mid, col);
  for (const k of to) line(x(col), mid, x(k), HEIGHT, k);
  return `<svg class="gitgraph" width="${width}" height="${HEIGHT}" aria-hidden="true">${lines.join("")}<circle cx="${x(col)}" cy="${mid}" r="3.5" fill="${COLOURS[col % COLOURS.length]}"/></svg>`;
}
