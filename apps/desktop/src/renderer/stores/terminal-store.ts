import { create } from "zustand";

type TerminalStore = {
	isOpen: boolean;
	setOpen: (open: boolean) => void;
};

export const useTerminalStore = create<TerminalStore>((set) => ({
	isOpen: false,
	setOpen: (open) => set({ isOpen: open }),
}));
