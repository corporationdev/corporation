import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { create } from "zustand";
import type { SpaceBacking } from "@/components/chat/agent-view";

type PendingSpaceCreation = {
	projectId: Id<"projects">;
	backing: SpaceBacking;
};

type PendingMessage = {
	text: string;
	agent: string;
	modelId: string;
	modeId: string;
	reasoningEffort: string | null;
	spaceCreation?: PendingSpaceCreation;
};

type PendingMessageStore = {
	message: PendingMessage | null;
	setMessage: (message: PendingMessage) => void;
	consumeMessage: () => PendingMessage | null;
};

export const usePendingMessageStore = create<PendingMessageStore>(
	(set, get) => ({
		message: null,
		setMessage: (message) => set({ message }),
		consumeMessage: () => {
			const message = get().message;
			set({ message: null });
			return message;
		},
	})
);
