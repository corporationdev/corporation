import { api } from "@corporation/backend/convex/_generated/api";
import { LoaderIcon, RefreshCwIcon } from "lucide-react";
import type { FC } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLatestShas } from "@/hooks/use-latest-shas";
import { useConvexTanstackMutation } from "@/lib/convex-mutation";
import { cn } from "@/lib/utils";
import type { Space } from "./space-sidebar";

export const SyncCodeButton: FC<{
	space: Space;
}> = ({ space }) => {
	const { repository } = space.environment;

	const { data: shas } = useLatestShas([repository], true);
	const latestSha = shas?.[`${repository.owner}/${repository.name}`];

	const isCodeOutdated =
		!!latestSha &&
		(!space.lastSyncedCommitSha || latestSha !== space.lastSyncedCommitSha);

	const syncMutation = useConvexTanstackMutation(api.spaces.syncCode, {
		onSuccess: () => {
			toast.success("Code sync started");
		},
		onError: (error) => {
			toast.error(`Sync failed: ${error.message}`);
		},
	});

	return (
		<Button
			className="w-full items-center gap-2"
			disabled={syncMutation.isPending}
			onClick={() => syncMutation.mutate({ id: space._id })}
			size="sm"
			variant="outline"
		>
			{syncMutation.isPending ? (
				<LoaderIcon className="size-4 animate-spin" />
			) : (
				<RefreshCwIcon className="size-4" />
			)}
			<span className="flex-1 text-left">
				{syncMutation.isPending ? "Syncing..." : "Sync Code"}
			</span>
			{!syncMutation.isPending && latestSha && (
				<Tooltip>
					<TooltipTrigger
						className="flex items-center"
						onClick={(e) => e.stopPropagation()}
						render={<span />}
					>
						<span
							className={cn(
								"size-2 rounded-full",
								isCodeOutdated ? "bg-amber-500" : "bg-green-500"
							)}
						/>
					</TooltipTrigger>
					<TooltipContent side="left">
						{isCodeOutdated
							? `Out of sync with ${repository.defaultBranch}`
							: "Code is in sync"}
					</TooltipContent>
				</Tooltip>
			)}
		</Button>
	);
};
