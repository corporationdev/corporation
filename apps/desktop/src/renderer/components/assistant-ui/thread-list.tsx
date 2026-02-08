import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
	ArchiveIcon,
	MoreHorizontalIcon,
	PlusIcon,
	RotateCcwIcon,
	Trash2Icon,
} from "lucide-react";
import { type FC, useCallback } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { convexSessionToLocal } from "@/lib/cache/mappers";
import { useCachedQuery } from "@/lib/cache/use-cached-query";
import { cn } from "@/lib/utils";

export const ThreadList: FC = () => {
	const remoteThreads = useQuery(api.agentSessions.list, {});

	const readCache = useCallback(() => window.localCache.sessions.getAll(), []);
	const writeCache = useCallback(
		(remote: NonNullable<typeof remoteThreads>) => {
			window.localCache.sessions.replaceAll(remote.map(convexSessionToLocal));
		},
		[]
	);

	const { data: threads } = useCachedQuery({
		readCache,
		writeCache,
		remoteData: remoteThreads,
	});

	const regularThreads = threads.filter((thread) => thread.archivedAt === null);

	return (
		<div className="flex flex-col gap-1">
			<ThreadListNew />
			{regularThreads.map((thread) => (
				<ThreadListItem
					id={thread.id as Id<"agentSessions">}
					key={thread.id}
					title={thread.title || "New Chat"}
				/>
			))}
			<ArchivedThreadList />
		</div>
	);
};

const ThreadListNew: FC = () => {
	const navigate = useNavigate();

	return (
		<Button
			className="h-9 justify-start gap-2 rounded-lg px-3 text-sm hover:bg-muted"
			onClick={() => navigate({ to: "/chat" })}
			variant="outline"
		>
			<PlusIcon className="size-4" />
			New Thread
		</Button>
	);
};

const ThreadListItem: FC<{ id: Id<"agentSessions">; title: string }> = ({
	id,
	title,
}) => {
	const navigate = useNavigate();
	const match = useMatch({
		from: "/_authenticated/chat/$threadId",
		shouldThrow: false,
	});
	const updateThread = useMutation(api.agentSessions.update);
	const deleteThread = useMutation(api.agentSessions.remove);
	const currentThreadId = match?.params.threadId;

	const isActive = currentThreadId === id;

	const handleSelect = () => {
		navigate({
			to: "/chat/$threadId",
			params: { threadId: id },
		});
	};

	const handleArchive = async () => {
		await updateThread({ id, archivedAt: Date.now() });
		if (isActive) {
			navigate({
				to: "/chat",
			});
		}
	};

	const handleDelete = async () => {
		await deleteThread({ id });
		if (isActive) {
			navigate({
				to: "/chat",
			});
		}
	};

	return (
		<div
			className={cn(
				"group flex h-9 items-center gap-2 rounded-lg transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
				isActive && "bg-muted"
			)}
		>
			<button
				className="flex h-full min-w-0 flex-1 items-center truncate px-3 text-start text-sm"
				onClick={handleSelect}
				type="button"
			>
				{title}
			</button>
			<ThreadListItemMore onArchive={handleArchive} onDelete={handleDelete} />
		</div>
	);
};

const ThreadListItemMore: FC<{
	onArchive: () => void;
	onDelete: () => void;
}> = ({ onArchive, onDelete }) => {
	return (
		<DropdownMenu>
			<Button
				className="mr-2 size-7 p-0 opacity-0 transition-opacity group-hover:opacity-100 data-[popup-open]:bg-accent data-[popup-open]:opacity-100"
				render={<DropdownMenuTrigger />}
				size="icon"
				variant="ghost"
			>
				<MoreHorizontalIcon className="size-4" />
				<span className="sr-only">More options</span>
			</Button>
			<DropdownMenuContent align="start" side="bottom">
				<DropdownMenuItem onClick={onArchive}>
					<ArchiveIcon className="size-4" />
					Archive
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onDelete} variant="destructive">
					<Trash2Icon className="size-4" />
					Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};

export const ArchivedThreadList: FC = () => {
	const navigate = useNavigate();
	const remoteThreads = useQuery(api.agentSessions.list, {});
	const updateThread = useMutation(api.agentSessions.update);

	const readCache = useCallback(() => window.localCache.sessions.getAll(), []);
	const writeCache = useCallback(
		(remote: NonNullable<typeof remoteThreads>) => {
			window.localCache.sessions.replaceAll(remote.map(convexSessionToLocal));
		},
		[]
	);

	const { data: threads } = useCachedQuery({
		readCache,
		writeCache,
		remoteData: remoteThreads,
	});

	const archivedThreads = threads.filter(
		(thread) => thread.archivedAt !== null
	);

	const handleUnarchive = async (id: Id<"agentSessions">) => {
		await updateThread({ id, archivedAt: null });
	};

	if (archivedThreads.length === 0) {
		return null;
	}

	return (
		<div className="mt-4 flex flex-col gap-1">
			<div className="px-3 font-medium text-muted-foreground text-xs">
				Archived
			</div>
			{archivedThreads.map((thread) => (
				<div
					className="group flex h-9 items-center gap-2 rounded-lg transition-colors hover:bg-muted"
					key={thread.id}
				>
					<button
						className="flex h-full min-w-0 flex-1 items-center truncate px-3 text-start text-muted-foreground text-sm"
						onClick={() =>
							navigate({
								to: "/chat/$threadId",
								params: { threadId: thread.id },
							})
						}
						type="button"
					>
						{thread.title || "New Chat"}
					</button>
					<Button
						className="mr-2 size-7 p-0 opacity-0 transition-opacity group-hover:opacity-100"
						onClick={() => handleUnarchive(thread.id as Id<"agentSessions">)}
						size="icon"
						variant="ghost"
					>
						<RotateCcwIcon className="size-4" />
						<span className="sr-only">Unarchive</span>
					</Button>
				</div>
			))}
		</div>
	);
};
