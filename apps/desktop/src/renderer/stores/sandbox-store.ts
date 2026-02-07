import type { SandboxState } from "@corporation/server/agent-types";
import { create } from "zustand";

type SandboxStore = SandboxState & {
	setSandboxState: (state: SandboxState) => void;
	reset: () => void;
};

const initialState: SandboxState = {
	sandbox: null,
	previewUrl: null,
	events: [],
};

export const useSandboxStore = create<SandboxStore>((set) => ({
	...initialState,
	setSandboxState: (state) => set(state),
	reset: () => set(initialState),
}));
