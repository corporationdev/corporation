import { create } from "zustand";

type SpaceSelectionStore = {
	selectedSpaceId: string | null;
	setSelectedSpaceId: (id: string | null) => void;
};

export const useSpaceSelectionStore = create<SpaceSelectionStore>((set) => ({
	selectedSpaceId: null,
	setSelectedSpaceId: (id) => set({ selectedSpaceId: id }),
}));
