import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { create } from "zustand";

type PendingSpace = {
	slug: string;
	projectId: Id<"projects">;
};

type PendingMessage = {
	text: string;
	agent: string;
	modelId: string;
};

type PendingMessageStore = {
	space: PendingSpace | null;
	message: PendingMessage | null;
	setSpace: (space: PendingSpace) => void;
	consumeSpace: () => PendingSpace | null;
	setMessage: (message: PendingMessage) => void;
	consumeMessage: () => PendingMessage | null;
};

export const usePendingMessageStore = create<PendingMessageStore>(
	(set, get) => ({
		space: null,
		message: null,
		setSpace: (space) => set({ space }),
		consumeSpace: () => {
			const space = get().space;
			set({ space: null });
			return space;
		},
		setMessage: (message) => set({ message }),
		consumeMessage: () => {
			const message = get().message;
			set({ message: null });
			return message;
		},
	})
);
