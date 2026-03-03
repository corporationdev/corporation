import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { type FC, type ReactNode, useState } from "react";

import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

import { RenameInput, RenameMenuItem } from "./rename-item";

export const SpaceContextMenu: FC<{
	spaceId: Id<"spaces">;
	branchName: string;
	isActive: boolean;
	children: ReactNode;
}> = ({ spaceId, branchName, isActive, children }) => {
	const [isRenaming, setIsRenaming] = useState(false);

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
					<RenameInput
						branchName={branchName}
						onDone={() => setIsRenaming(false)}
						spaceId={spaceId}
					/>
				) : (
					children
				)}
			</ContextMenuTrigger>
			<ContextMenuContent>
				<RenameMenuItem onRename={() => setIsRenaming(true)} />
			</ContextMenuContent>
		</ContextMenu>
	);
};
