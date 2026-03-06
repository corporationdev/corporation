import { create } from "zustand";

const STORAGE_KEY = "layout-state";

type LayoutState = {
	leftSidebarOpen: boolean;
};

type LayoutStore = LayoutState & {
	setLeftSidebarOpen: (open: boolean) => void;
};

const DEFAULTS: LayoutState = {
	leftSidebarOpen: true,
};

function readState(): LayoutState {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<LayoutState>;
			return { ...DEFAULTS, ...parsed };
		}
	} catch {
		// Fall back to defaults if localStorage is unavailable or corrupt
	}
	return DEFAULTS;
}

function writeState(state: LayoutState) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Ignore write failures
	}
}

const initial = readState();

export const useLayoutStore = create<LayoutStore>((set) => ({
	...initial,
	setLeftSidebarOpen: (open) => {
		set({ leftSidebarOpen: open });
		writeState({ leftSidebarOpen: open });
	},
}));
