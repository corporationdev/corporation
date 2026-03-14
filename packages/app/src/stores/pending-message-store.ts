import { create } from "zustand";

type PendingMessage = {
	text: string;
	agent: string;
	modelId: string;
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
