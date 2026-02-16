import { api } from "@corporation/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { CopyIcon } from "lucide-react";
import type { FC } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export const CopyInspectorUrl: FC<{ slug: string }> = ({ slug }) => {
	const session = useQuery(api.agentSessions.getBySlug, { slug });

	if (!session?.space.sandboxUrl) {
		return null;
	}

	const inspectorUrl = `${session.space.sandboxUrl}/ui/`;

	return (
		<Button
			onClick={() => {
				navigator.clipboard.writeText(inspectorUrl);
				toast.success("Inspector URL copied");
			}}
			size="icon-sm"
			variant="ghost"
		>
			<CopyIcon className="size-3.5" />
		</Button>
	);
};
