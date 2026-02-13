import { create } from "zustand";

type PendingMessage = {
	text: string;
	environmentId: string;
	repositoryId: string;
	selectedSpaceId?: string;
};

type PendingMessageStore = {
	pending: PendingMessage | null;
	setPending: (message: PendingMessage) => void;
	consumePending: () => PendingMessage | null;
};

export const usePendingMessageStore = create<PendingMessageStore>(
	(set, get) => ({
		pending: null,
		setPending: (message) => set({ pending: message }),
		consumePending: () => {
			const message = get().pending;
			set({ pending: null });
			return message;
		},
	})
);
