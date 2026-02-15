import { create } from "zustand";

type PermissionData = {
	requestId: string;
	title: string;
	rawInput?: unknown;
};

type PermissionReply = "once" | "always" | "reject";

type PermissionStore = {
	pendingPermissions: Record<string, PermissionData>;
	replyPermission:
		| ((permissionId: string, reply: PermissionReply) => Promise<void>)
		| null;

	onPermission: (
		requestId: string,
		toolCall: { title: string; rawInput?: unknown }
	) => void;
	resolvePermission: (requestId: string) => void;
	setReplyPermission: (fn: PermissionStore["replyPermission"]) => void;
	reset: () => void;
};

export const usePermissionStore = create<PermissionStore>((set) => ({
	pendingPermissions: {},
	replyPermission: null,

	onPermission: (requestId, toolCall) =>
		set((s) => ({
			pendingPermissions: {
				...s.pendingPermissions,
				[requestId]: {
					requestId,
					title: toolCall.title,
					rawInput: toolCall.rawInput,
				},
			},
		})),
	resolvePermission: (requestId) =>
		set((s) => {
			const { [requestId]: _, ...rest } = s.pendingPermissions;
			return { pendingPermissions: rest };
		}),
	setReplyPermission: (fn) => set({ replyPermission: fn }),
	reset: () => set({ pendingPermissions: {}, replyPermission: null }),
}));
