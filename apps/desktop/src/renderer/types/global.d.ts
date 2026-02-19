import type { CacheAdapter } from "@corporation/app/cache-adapter";

declare global {
	// biome-ignore lint/style/useConsistentTypeDefinitions: interface is required for global declaration merging
	interface Window {
		localCache: CacheAdapter;
	}
}
