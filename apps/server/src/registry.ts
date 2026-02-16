import { setup } from "rivetkit";
import { agent } from "./agent";
import { terminal } from "./terminal";

// Workaround: rivetkit's Registry constructor calls setTimeout() which is
// disallowed in Cloudflare Workers global scope when using alchemy/Miniflare.
// The timeout only bootstraps rivetkit's own runner, which is unused on CF Workers.
// See: https://github.com/rivet-dev/rivetkit/issues/XXX
const _setTimeout = globalThis.setTimeout;
globalThis.setTimeout = (() => 0) as unknown as typeof globalThis.setTimeout;
export const registry = setup({
	use: { agent, terminal },
});
globalThis.setTimeout = _setTimeout;
