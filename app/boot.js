// The app not loaded: where one of its modules could not be had (the server refused the connection for a moment, as when
// it is started again), the browser runs none of them, and says so only in its console: the page would say "loading…"
// for good. This is not one of them (a plain script, run before them, with nothing to import), so it is there to see that.
// The page is loaded again (a module once refused stays refused in this page), a few times, a little later each time;
// then it says what is wrong and stops.
(() => {
  const KEY = "fettled.bootTries", TRIES = 3, WITHIN = 60e3;
  const said = (text) => { const s = document.getElementById("status"); if (s) s.textContent = text; };
  let tries = [], failed = false;
  try { tries = JSON.parse(sessionStorage.getItem(KEY) ?? "[]").filter((t) => Date.now() - t < WITHIN); } catch (_) { /* none kept */ }
  // (A module script that is the page's own, not loaded: an `error` at it, which is heard on its way down to it.)
  document.addEventListener("error", (e) => {
    const s = e.target;
    if (!(s instanceof HTMLScriptElement) || s.type !== "module") return;
    failed = true;
    const host = location.host || "the server";
    console.error(`the app could not be loaded: one of its files (${s.src} or one it imports) was not had from ${host}: see the failed request above`);
    if (tries.length >= TRIES) {
      said(`the app could not be loaded from ${host} (tried ${tries.length + 1} times): is fettled serve running? Then reload the page`);
      try { sessionStorage.removeItem(KEY); } catch (_) { /* as it is */ }
      return;
    }
    const wait = 500 * 2 ** tries.length;
    said(`the app could not be loaded from ${host}: trying again in ${wait / 1000} s`);
    try { sessionStorage.setItem(KEY, JSON.stringify([...tries, Date.now()])); } catch (_) { /* tried without counting */ }
    setTimeout(() => location.reload(), wait);
  }, true);
  // (Loaded: the tries begin again from none.)
  addEventListener("load", () => { if (!failed) try { sessionStorage.removeItem(KEY); } catch (_) { /* as it is */ } });
})();
