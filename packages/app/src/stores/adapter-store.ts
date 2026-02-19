import { create } from "zustand";

// Extend this type as platform adapters are added (e.g. cache, webPreview, etc.)
// biome-ignore lint/complexity/noBannedTypes: empty placeholder until adapters are added
export type PlatformAdapters = {};

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
