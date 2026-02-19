import { api } from "@corporation/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { BoxIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import type { FC } from "react";
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
import { useSpaceSelectionStore } from "@/stores/space-selection-store";

export const SpaceSelector: FC = () => {
	const spaces = useQuery(api.spaces.list);
	const selectedSpaceId = useSpaceSelectionStore((s) => s.selectedSpaceId);
	const setSelectedSpaceId = useSpaceSelectionStore(
		(s) => s.setSelectedSpaceId
	);

	const selected = spaces?.find((s) => s._id === selectedSpaceId);
	const label = selected
		? `${selected.branchName} (${selected.status})`
		: "New space";

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
							<span className="ml-auto text-muted-foreground text-xs">
								{space.status}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
