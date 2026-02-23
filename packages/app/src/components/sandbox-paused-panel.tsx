import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { LoaderIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStartSandbox } from "@/hooks/use-start-sandbox";

const statusLabelByValue: Record<string, string> = {
	creating: "Creating",
	starting: "Starting",
	started: "Running",
	stopped: "Stopped",
	error: "Error",
};

type SandboxPausedPanelProps = {
	spaceId: Id<"spaces">;
	status: string;
};

export function SandboxPausedPanel({
	spaceId,
	status,
}: SandboxPausedPanelProps) {
	const { isStartDisabled, isStarting, startSandbox } = useStartSandbox({
		spaceId,
		status,
	});

	const statusLabel = statusLabelByValue[status] ?? status;

	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-6">
			<div className="w-full max-w-md rounded-lg border bg-card p-6">
				<h2 className="font-semibold text-xl">Sandbox paused</h2>
				<p className="mt-2 text-muted-foreground text-sm">
					This tab requires an active sandbox. Start it to continue.
				</p>
				<p className="mt-4 text-muted-foreground text-sm">
					Status: {statusLabel}
				</p>
				<Button
					className="mt-4 w-full justify-center gap-2"
					disabled={isStartDisabled}
					onClick={startSandbox}
					type="button"
				>
					{isStarting ? (
						<LoaderIcon className="size-4 animate-spin" />
					) : (
						<PlayIcon className="size-4" />
					)}
					{isStarting ? "Starting..." : "Start Sandbox"}
				</Button>
			</div>
		</div>
	);
}
