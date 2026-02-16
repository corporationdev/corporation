import { create } from "zustand";

const DEFAULT_PANEL_HEIGHT = 250;
const MIN_PANEL_HEIGHT = 100;
const MAX_PANEL_HEIGHT_RATIO = 0.7;

type TerminalStore = {
	isOpen: boolean;
	panelHeight: number;
	setOpen: (open: boolean) => void;
	setPanelHeight: (height: number) => void;
};

export const useTerminalStore = create<TerminalStore>((set) => ({
	isOpen: false,
	panelHeight: DEFAULT_PANEL_HEIGHT,
	setOpen: (open) => set({ isOpen: open }),
	setPanelHeight: (height) => {
		const maxHeight = window.innerHeight * MAX_PANEL_HEIGHT_RATIO;
		const clamped = Math.max(MIN_PANEL_HEIGHT, Math.min(height, maxHeight));
		set({ panelHeight: clamped });
	},
}));

export { MAX_PANEL_HEIGHT_RATIO, MIN_PANEL_HEIGHT };
