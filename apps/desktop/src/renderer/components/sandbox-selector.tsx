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
import { useSandboxSelectionStore } from "@/stores/sandbox-selection-store";

export const SandboxSelector: FC = () => {
	const sandboxes = useQuery(api.sandboxes.list);
	const selectedSandboxId = useSandboxSelectionStore(
		(s) => s.selectedSandboxId
	);
	const setSelectedSandboxId = useSandboxSelectionStore(
		(s) => s.setSelectedSandboxId
	);

	const selected = sandboxes?.find((s) => s._id === selectedSandboxId);
	const label = selected
		? `${selected.branchName} (${selected.status})`
		: "New sandbox";

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
					<DropdownMenuLabel>Sandbox</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setSelectedSandboxId(null)}>
						<PlusIcon className="size-4" />
						New sandbox
					</DropdownMenuItem>
					{sandboxes?.map((sandbox) => (
						<DropdownMenuItem
							key={sandbox._id}
							onClick={() => setSelectedSandboxId(sandbox._id)}
						>
							<BoxIcon className="size-4" />
							{sandbox.branchName}
							<span className="ml-auto text-muted-foreground text-xs">
								{sandbox.status}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
