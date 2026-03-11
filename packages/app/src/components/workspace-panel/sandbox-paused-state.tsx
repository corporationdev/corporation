import { api } from "@corporation/backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { LoaderCircleIcon, PauseCircleIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type SandboxPausedStateProps = {
	spaceSlug: string;
	status: "creating" | "running" | "paused" | "killed" | "error" | "loading";
};

function getSandboxStateCopy(status: SandboxPausedStateProps["status"]): {
	title: string;
	description: string;
	canResume: boolean;
} {
	switch (status) {
		case "creating":
			return {
				title: "Sandbox starting",
				description:
					"The workspace is provisioning. You can return to chat while it comes back online.",
				canResume: false,
			};
		case "error":
			return {
				title: "Sandbox unavailable",
				description:
					"The last sandbox run failed. Resume it when you want workspace access again.",
				canResume: true,
			};
		case "loading":
			return {
				title: "Loading workspace",
				description: "Checking the current sandbox state.",
				canResume: false,
			};
		case "killed":
			return {
				title: "Sandbox stopped",
				description:
					"This workspace is offline. Resume it only when you need terminal or desktop access.",
				canResume: true,
			};
		default:
			return {
				title: "Sandbox paused",
				description:
					"This workspace is currently offline. Resume it when you need terminal or desktop access.",
				canResume: true,
			};
	}
}

export function SandboxPausedState({
	spaceSlug,
	status,
}: SandboxPausedStateProps) {
	const ensureSpace = useMutation(api.spaces.ensure);
	const { title, description, canResume } = getSandboxStateCopy(status);
	const [isResuming, setIsResuming] = useState(false);
	const isCreating = status === "creating" || isResuming;

	const handleResume = async () => {
		setIsResuming(true);
		try {
			await ensureSpace({ slug: spaceSlug });
			toast.success("Sandbox resume started");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to resume sandbox"
			);
			setIsResuming(false);
		}
	};

	return (
		<div className="flex h-full items-center justify-center px-6">
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				<div className="rounded-full border border-border bg-muted/40 p-3">
					{isCreating ? (
						<LoaderCircleIcon className="size-6 animate-spin text-muted-foreground" />
					) : (
						<PauseCircleIcon className="size-6 text-muted-foreground" />
					)}
				</div>
				<div className="space-y-1">
					<h2 className="font-medium text-base">{title}</h2>
					<p className="text-muted-foreground text-sm">{description}</p>
				</div>
				<Button
					disabled={!canResume || isResuming}
					onClick={handleResume}
					size="sm"
					variant="outline"
				>
					{isCreating ? (
						<LoaderCircleIcon className="animate-spin" />
					) : (
						<RefreshCwIcon />
					)}
					{isCreating ? "Starting..." : "Resume sandbox"}
				</Button>
			</div>
		</div>
	);
}
