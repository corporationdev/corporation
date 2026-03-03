import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { BoxIcon, PencilIcon } from "lucide-react";
import { type FC, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ContextMenuItem } from "@/components/ui/context-menu";

export const RenameInput: FC<{
	branchName: string;
	spaceId: Id<"spaces">;
	onDone: () => void;
}> = ({ branchName, spaceId, onDone }) => {
	const [value, setValue] = useState(branchName);
	const inputRef = useRef<HTMLInputElement>(null);
	const skipCommitRef = useRef(false);
	const updateBranchName = useMutation(api.spaces.updateBranchName);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	const commit = () => {
		if (skipCommitRef.current) {
			skipCommitRef.current = false;
			return;
		}

		onDone();
		if (value !== branchName) {
			updateBranchName({ id: spaceId, branchName: value }).catch(() => {
				toast.error("Failed to rename branch");
			});
		}
	};

	return (
		<div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
			<BoxIcon className="size-3.5 shrink-0" />
			<input
				className="min-w-0 flex-1 truncate bg-transparent text-sm outline-none"
				onBlur={commit}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						inputRef.current?.blur();
					}
					if (e.key === "Escape") {
						skipCommitRef.current = true;
						setValue(branchName);
						onDone();
					}
				}}
				ref={inputRef}
				type="text"
				value={value}
			/>
		</div>
	);
};

export const RenameMenuItem: FC<{
	onRename: () => void;
}> = ({ onRename }) => {
	return (
		<ContextMenuItem onClick={onRename}>
			<PencilIcon />
			Rename
		</ContextMenuItem>
	);
};
