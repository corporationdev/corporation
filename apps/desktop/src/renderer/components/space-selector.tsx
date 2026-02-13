import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useQuery } from "convex/react";
import {
	BoxIcon,
	ChevronDownIcon,
	DownloadIcon,
	LoaderIcon,
	PlusIcon,
} from "lucide-react";
import type { FC, MouseEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiClient } from "@/lib/api-client";
import { useSpaceSelectionStore } from "@/stores/space-selection-store";

async function pullSpace(spaceId: Id<"spaces">) {
	const res = await apiClient.spaces.pull.$post({
		json: { spaceId },
	});
	if (!res.ok) {
		const data = await res.json();
		throw new Error(data.error);
	}
	return res.json();
}

export const SpaceSelector: FC = () => {
	const spaces = useQuery(api.spaces.list);
	const selectedSpaceId = useSpaceSelectionStore((s) => s.selectedSpaceId);
	const setSelectedSpaceId = useSpaceSelectionStore(
		(s) => s.setSelectedSpaceId
	);

	const pullMutation = useTanstackMutation({
		mutationFn: pullSpace,
		onSuccess: () => toast.success("Pulled latest changes"),
		onError: (error) => toast.error(`Pull failed: ${error.message}`),
	});

	const selected = spaces?.find((s) => s._id === selectedSpaceId);
	const label = selected
		? `${selected.branchName} (${selected.status})`
		: "New space";

	const handlePull = (e: MouseEvent, spaceId: Id<"spaces">) => {
		e.stopPropagation();
		pullMutation.mutate(spaceId);
	};

	return (
		<DropdownMenu>
			<Button
				className="h-8 gap-1.5 px-2.5 text-sm"
				render={<DropdownMenuTrigger />}
				variant="outline"
			>
				<BoxIcon className="size-3.5" />
				{label}
				<ChevronDownIcon className="size-3.5 text-muted-foreground" />
			</Button>
			<DropdownMenuContent align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Space</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setSelectedSpaceId(null)}>
						<PlusIcon className="size-4" />
						New space
					</DropdownMenuItem>
					{spaces?.map((space) => (
						<DropdownMenuItem
							key={space._id}
							onClick={() => setSelectedSpaceId(space._id)}
						>
							<BoxIcon className="size-4" />
							{space.branchName}
							<span className="ml-auto flex items-center gap-1.5">
								<span className="text-muted-foreground text-xs">
									{space.status}
								</span>
								{space.status === "started" && (
									<button
										className="rounded p-0.5 hover:bg-accent"
										disabled={pullMutation.isPending}
										onClick={(e) => handlePull(e, space._id)}
										type="button"
									>
										{pullMutation.isPending &&
										pullMutation.variables === space._id ? (
											<LoaderIcon className="size-3.5 animate-spin" />
										) : (
											<DownloadIcon className="size-3.5" />
										)}
									</button>
								)}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
