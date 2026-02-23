import { create } from "zustand";

type SpaceSidebarStore = {
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
};

export const useSpaceSidebarStore = create<SpaceSidebarStore>((set) => ({
	isOpen: false,
	setIsOpen: (open) => set({ isOpen: open }),
}));
