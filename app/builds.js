// One root part's builds (project.js `Root`): what may change what it is built of only says so (`want`), and one loop builds it as it
// is when each build begins. The rules, which web/tools/builds-test.mjs holds it to:
//
//   - A trigger never builds: it marks what is wanted as changed (`dirty`), and the loop, where it is not running, is begun.
//   - Each build is of what is wanted when it begins (`once` reads that itself: the files as the store has them then).
//   - A build that something changed under while it ran (`dirty` again) is let go of, never taken; who waited for it waits for the next.
//   - One that fails is said (`failed`), and tried again a little later, up to `retries` times, where nothing else has asked meanwhile.
//   - While a drag holds the solver (`hold` to `release`), nothing is built, and nothing is cancelled; a drag not moved for `held` ms is
//     let go of (one whose end was lost).
//   - Who waits for a build (`want`'s answer) hears of the first one taken (or found the same) that began after they asked.

export class Builds {
  /**
   * `once(reasons, stale)`: one build, of what is wanted now: `{ version, said }`, or `{ superseded: true }` where `stale()` said that
   * something changed while it ran; throws where it fails (`cancelled(e)`: let go of by `cancel`, not failed). The rest are told:
   * `cancel()` (what is being built is to stop, where it can), `began()`, `ended()`, `failed(e)`, `built(version)`, `trace(data)`.
   */
  constructor(hooks, { retries = 3, held = 15000, later = (f, ms) => setTimeout(f, ms), now = () => performance.now() } = {}) {
    Object.assign(this, { hooks, retries, held, later, now });
    this.wants = [];
    this.dirty = false;
    this.running = false;
    this.failures = 0;
    /** Whether a drag holds the solver, and when it last moved. */
    this.dragging = false;
    this.moved = 0;
    this.undrag = [];
    this.whenIdle = [];
  }
  /** Whether a build is running, or waits to be. */
  get busy() { return this.running || this.wants.length > 0; }
  /** Answers once nothing is being built, or waits to be. */
  idle() { return this.busy ? new Promise((done) => this.whenIdle.push(done)) : Promise.resolve(); }

  /** What it is built of may have changed (`reason`, as the trace says it). Answers with the version of the first build begun after
   *  this that is taken; fails where that build fails. */
  want(reason) {
    return new Promise((resolve, reject) => {
      this.wants.push({ resolve, reject, reason });
      this.dirty = true;
      this.hooks.trace?.({ want: reason });
      if (!this.running) return void this.loop();
      // (Being built: what it builds is let go of, where it can be, unless a drag holds it.)
      if (!this.dragging) this.hooks.cancel?.();
    });
  }

  /** A drag holds the solver from now (each move says so), till `release`. */
  hold() {
    this.dragging = true;
    this.moved = this.now();
  }
  release() {
    this.dragging = false;
    for (const f of this.undrag.splice(0)) f();
  }
  async undragged() {
    while (this.dragging) {
      const left = this.moved + this.held - this.now();
      if (left <= 0) { this.hooks.trace?.({ drag: "let go of, unmoved" }); this.release(); break; }
      await new Promise((done) => { this.undrag.push(done); this.later(done, left); });
    }
  }

  async loop() {
    this.running = true;
    this.hooks.began?.();
    while (this.dirty) {
      await this.undragged();
      this.dirty = false;
      const batch = this.wants.splice(0), reasons = [...new Set(batch.map((x) => x.reason))], since = this.now();
      let r;
      try {
        r = await this.hooks.once(reasons, () => this.dirty);
      } catch (e) {
        r = this.hooks.cancelled?.(e) ? { superseded: true } : { failed: e };
      }
      const ms = Math.round(this.now() - since);
      if (r.failed) {
        this.hooks.trace?.({ reasons, result: "failed", error: String(r.failed?.message ?? r.failed), ms });
        for (const x of batch) x.reject(r.failed);
        this.hooks.failed?.(r.failed);
        if (++this.failures <= this.retries) this.later(() => { if (!this.busy) this.want("again, after it failed").catch(() => {}); }, 1000 * 2 ** this.failures);
        continue;
      }
      // (Something changed under it: let go of; who waited for it waits for the next, of what is wanted now.)
      if (r.superseded || this.dirty) {
        this.hooks.trace?.({ reasons, result: "superseded", ms });
        this.wants.unshift(...batch);
        this.dirty = true;
        continue;
      }
      this.failures = 0;
      this.hooks.trace?.({ reasons, ...r.said, ms });
      for (const x of batch) x.resolve(r.version);
      this.hooks.built?.(r.version);
    }
    this.running = false;
    this.hooks.ended?.();
    for (const f of this.whenIdle.splice(0)) f();
  }
}
