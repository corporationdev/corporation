import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { ArchiveIcon, BoxIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type FC, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

export const SpaceContextMenu: FC<{
	spaceId: Id<"spaces">;
	slug: string;
	branchName: string;
	isActive: boolean;
	children: ReactNode;
}> = ({ spaceId, branchName, isActive, children }) => {
	const navigate = useNavigate();
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(branchName);
	const inputRef = useRef<HTMLInputElement>(null);
	const skipCommitRef = useRef(false);

	const updateBranchName = useMutation(api.spaces.updateBranchName);
	const archiveSpace = useMutation(api.spaces.archive);
	const deleteSpace = useMutation(api.spaces.delete);

	useEffect(() => {
		if (isRenaming) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isRenaming]);

	const commitRename = () => {
		if (skipCommitRef.current) {
			skipCommitRef.current = false;
			return;
		}
		setIsRenaming(false);
		if (renameValue !== branchName) {
			updateBranchName({ id: spaceId, branchName: renameValue }).catch(() => {
				toast.error("Failed to rename branch");
			});
		}
	};

	const navigateAway = () => {
		if (isActive) {
			navigate({ to: "/" });
		}
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<div
						className={cn(
							"group/item flex h-9 items-center gap-2 rounded-lg transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
							isActive && "bg-muted"
						)}
					/>
				}
			>
				{isRenaming ? (
					<div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
						<BoxIcon className="size-3.5 shrink-0" />
						<input
							className="min-w-0 flex-1 truncate bg-transparent text-sm outline-none"
							onBlur={commitRename}
							onChange={(e) => setRenameValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									inputRef.current?.blur();
								}
								if (e.key === "Escape") {
									skipCommitRef.current = true;
									setRenameValue(branchName);
									setIsRenaming(false);
								}
							}}
							ref={inputRef}
							type="text"
							value={renameValue}
						/>
					</div>
				) : (
					children
				)}
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem
					onClick={() => {
						setRenameValue(branchName);
						setIsRenaming(true);
					}}
				>
					<PencilIcon />
					Rename
				</ContextMenuItem>
				<ContextMenuItem
					onClick={() => {
						archiveSpace({ id: spaceId });
						navigateAway();
					}}
				>
					<ArchiveIcon />
					Archive
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem
					onClick={() => {
						deleteSpace({ id: spaceId });
						navigateAway();
					}}
					variant="destructive"
				>
					<Trash2Icon />
					Delete
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
};
