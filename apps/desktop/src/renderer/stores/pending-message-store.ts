import { create } from "zustand";

type PendingMessageStore = {
	pendingMessage: string | null;
	setPendingMessage: (message: string) => void;
	consumePendingMessage: () => string | null;
};

export const usePendingMessageStore = create<PendingMessageStore>(
	(set, get) => ({
		pendingMessage: null,
		setPendingMessage: (message) => set({ pendingMessage: message }),
		consumePendingMessage: () => {
			const message = get().pendingMessage;
			set({ pendingMessage: null });
			return message;
		},
	})
);
