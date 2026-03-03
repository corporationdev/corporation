import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { create } from "zustand";
import type { ComposerImageAttachment } from "@/components/chat/types";

type PendingMessage = {
	text: string;
	images: ComposerImageAttachment[];
	/** Set when creating a brand new space (no existing space yet) */
	environmentId?: Id<"environments">;
	/** Set when creating a session in an existing space */
	spaceSlug?: string;
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
