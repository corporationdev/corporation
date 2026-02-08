import type { PermissionEventData, PermissionReply } from "sandbox-agent";
import { create } from "zustand";

type PermissionStore = {
	pendingPermissions: Record<string, PermissionEventData>;
	replyPermission:
		| ((permissionId: string, reply: PermissionReply) => Promise<void>)
		| null;

	onPermissionEvent: (
		type: "permission.requested" | "permission.resolved",
		data: PermissionEventData
	) => void;
	setReplyPermission: (fn: PermissionStore["replyPermission"]) => void;
	reset: () => void;
};

export const usePermissionStore = create<PermissionStore>((set) => ({
	pendingPermissions: {},
	replyPermission: null,

	onPermissionEvent: (type, data) =>
		set((s) => {
			if (type === "permission.requested") {
				return {
					pendingPermissions: {
						...s.pendingPermissions,
						[data.permission_id]: data,
					},
				};
			}
			const { [data.permission_id]: _, ...rest } = s.pendingPermissions;
			return { pendingPermissions: rest };
		}),
	setReplyPermission: (fn) => set({ replyPermission: fn }),
	reset: () => set({ pendingPermissions: {}, replyPermission: null }),
}));
