import { ShieldAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { usePermissionStore } from "@/stores/permission-store";

export function PermissionOverlay() {
	const pendingPermissions = usePermissionStore((s) => s.pendingPermissions);
	const replyPermission = usePermissionStore((s) => s.replyPermission);
	const first = Object.values(pendingPermissions)[0];

	if (!first) {
		return null;
	}

	const handleReply = (reply: "once" | "always" | "reject") => {
		replyPermission?.(first.permission_id, reply);
	};

	return (
		<div className="flex flex-col gap-2 border p-3">
			<div className="flex items-center gap-2">
				<ShieldAlertIcon className="size-4 text-muted-foreground" />
				<span className="font-medium text-sm">Permission</span>
				<span className="ml-auto bg-yellow-500/15 px-1.5 py-0.5 font-medium text-xs text-yellow-600 dark:text-yellow-400">
					Pending
				</span>
			</div>
			<p className="text-muted-foreground text-xs">{first.action}</p>
			{first.metadata != null && (
				<pre className="overflow-x-auto bg-muted p-2 text-xs">
					{typeof first.metadata === "string"
						? first.metadata
						: JSON.stringify(first.metadata, null, 2)}
				</pre>
			)}
			<div className="flex gap-2">
				<Button onClick={() => handleReply("once")} size="xs" variant="default">
					Allow Once
				</Button>
				<Button
					onClick={() => handleReply("always")}
					size="xs"
					variant="outline"
				>
					Always
				</Button>
				<Button
					onClick={() => handleReply("reject")}
					size="xs"
					variant="destructive"
				>
					Reject
				</Button>
			</div>
		</div>
	);
}
