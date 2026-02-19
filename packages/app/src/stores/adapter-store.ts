import { create } from "zustand";
import type { CacheAdapter } from "@/lib/cache/adapter";

export type PlatformAdapters = {
	cache: CacheAdapter;
};

type AdapterStore = {
	adapters: PlatformAdapters | null;
	setAdapters: (adapters: PlatformAdapters) => void;
};

export const useAdapterStore = create<AdapterStore>((set) => ({
	adapters: null,
	setAdapters: (adapters) => set({ adapters }),
}));

export function initAdapters(adapters: PlatformAdapters): void {
	useAdapterStore.getState().setAdapters(adapters);
}

export function useAdapters(): PlatformAdapters {
	const adapters = useAdapterStore((s) => s.adapters);
	if (!adapters) {
		throw new Error(
			"Platform adapters not initialized. Call initAdapters() first."
		);
	}
	return adapters;
}

export function useCache(): CacheAdapter {
	return useAdapters().cache;
}
