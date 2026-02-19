import type { CacheAdapter } from "@corporation/app/cache-adapter";

export const electronCacheAdapter: CacheAdapter = {
	events: {
		getForSession: (sessionId) =>
			window.localCache.events.getForSession(sessionId),
		appendMany: (events) => window.localCache.events.appendMany(events),
	},
};
