// Merging (fettled-sync), once it is loaded: what a pull, a session and a write made from an older text all merge by.

let loading = null;
export const merger = () => (loading ??= import(new URL("../pkg/fettled_sync.js", import.meta.url).href).then(async (m) => (await m.default(), m)));
