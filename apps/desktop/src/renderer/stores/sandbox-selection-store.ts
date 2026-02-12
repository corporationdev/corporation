import { create } from "zustand";

type SandboxSelectionStore = {
	selectedSandboxId: string | null;
	setSelectedSandboxId: (id: string | null) => void;
};

export const useSandboxSelectionStore = create<SandboxSelectionStore>(
	(set) => ({
		selectedSandboxId: null,
		setSelectedSandboxId: (id) => set({ selectedSandboxId: id }),
	})
);
