import { create } from "zustand";

type TerminalStore = {
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
};

export const useTerminalStore = create<TerminalStore>((set) => ({
	isOpen: false,
	setIsOpen: (open) => set({ isOpen: open }),
}));
