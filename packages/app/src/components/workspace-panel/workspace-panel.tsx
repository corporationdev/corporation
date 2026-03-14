import { PanelRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type WorkspacePanelProps = {
	onClose: () => void;
};

export function WorkspacePanel({ onClose }: WorkspacePanelProps) {
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
				<h2 className="font-medium text-sm">Workspace</h2>
				<Button onClick={onClose} size="icon" variant="ghost">
					<PanelRightIcon className="size-4" />
					<span className="sr-only">Close workspace panel</span>
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 items-center justify-center p-6">
				<div className="rounded-md border px-4 py-3 font-medium text-sm">
					&lt;in construction&gt;
				</div>
			</div>
		</div>
	);
}
