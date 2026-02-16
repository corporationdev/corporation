import { CopyIcon } from "lucide-react";
import type { FC } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export const CopyInspectorUrl: FC<{ sandboxUrl: string }> = ({
	sandboxUrl,
}) => {
	const inspectorUrl = `${sandboxUrl}/ui/`;

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
