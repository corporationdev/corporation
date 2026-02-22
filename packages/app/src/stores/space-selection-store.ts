import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { create } from "zustand";

type SpaceSelectionStore = {
	selectedSpaceId: Id<"spaces"> | null;
	setSelectedSpaceId: (id: Id<"spaces"> | null) => void;
};

export const useSpaceSelectionStore = create<SpaceSelectionStore>((set) => ({
	selectedSpaceId: null,
	setSelectedSpaceId: (id) => set({ selectedSpaceId: id }),
}));
