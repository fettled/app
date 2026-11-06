// What this copy of the app is set up with. None of it is secret. (A project of its own can point these at its own.)

/** The GitHub App people sign in with, and the relay that has its secret (relay/). No `clientId`: no signing in here, and a
 *  repository is reached with a token pasted in. `slug`: the App's name in its address, where it is installed from. The
 *  broker's address is also in the site's security policy (`BROKER`, crates/fettled-cli/src/serve.rs). */
export const GITHUB_APP = {
  clientId: "Iv23li3YnbOgVb3l1aQf",
  slug: "fettled",
  broker: "https://relay.fettled.xyz",
  login: "https://github.com",
  api: "https://api.github.com",
  /** Where the app is published: what someone invited over the internet opens. */
  site: "https://app.fettled.xyz/",
};

/** The examples every page lists, read from their repository on GitHub (by anyone: it is public). */
export const EXAMPLES = { repo: "fettled/fettled-examples", branch: "main" };

/** Addresses of `account.github.io` kind whose every Pages site is this copy's owner's: a token can stay signed in there, and
 *  what is read be kept, for no one else's page shares them. (What those sites load is then trusted with them: see
 *  docs/github-store.md.) None here: this copy is served at a domain of its own. */
export const OWN_ORIGINS = [];
