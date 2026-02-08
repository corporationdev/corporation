import type { LocalCacheApi } from "../../shared/ipc-api";

declare global {
	// biome-ignore lint/style/useConsistentTypeDefinitions: interface required for global declaration merging
	interface Window {
		localCache: LocalCacheApi;
	}
}
