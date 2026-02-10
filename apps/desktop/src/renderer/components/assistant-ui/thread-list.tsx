import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMatch, useNavigate } from "@tanstack/react-router";
import {
	ArchiveIcon,
	MoreHorizontalIcon,
	PlusIcon,
	RotateCcwIcon,
	Trash2Icon,
} from "lucide-react";
import type { FC } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
	useOptimisticDeleteThreadMutation,
	useOptimisticUpdateThreadMutation,
} from "@/lib/agent-session-mutations";
import {
	AGENT_SESSIONS_CACHE_KEY,
	type ConvexAgentSession,
	readCachedAgentSessions,
	writeCachedAgentSessions,
} from "@/lib/cache/agent-sessions-adapter";
import { useCachedConvexQuery } from "@/lib/cache/use-cached-convex-query";
import { cn } from "@/lib/utils";

export const ThreadList: FC = () => {
	const cachedThreadsQuery = useCachedConvexQuery({
		query: api.agentSessions.list,
		args: {},
		cacheKey: AGENT_SESSIONS_CACHE_KEY,
		readCache: readCachedAgentSessions,
		writeCache: writeCachedAgentSessions,
	});
	const updateThread = useOptimisticUpdateThreadMutation();
	const deleteThread = useOptimisticDeleteThreadMutation();

	if (cachedThreadsQuery.isLoading) {
		return (
			<div className="flex flex-col gap-1">
				<ThreadListNew />
				<ThreadListSkeleton />
			</div>
		);
	}

	const threads = cachedThreadsQuery.data;
	const regularThreads = threads.filter((thread) => thread.archivedAt === null);

	return (
		<div className="flex flex-col gap-1">
			<ThreadListNew />
			{regularThreads.map((thread) => (
				<ThreadListItem
					id={thread._id}
					key={thread._id}
					onArchive={async () => {
						await updateThread({
							id: thread._id,
							archivedAt: Date.now(),
						});
					}}
					onDelete={async () => {
						await deleteThread({
							id: thread._id,
						});
					}}
					title={thread.title || "New Chat"}
				/>
			))}
			<ArchivedThreadList
				onUnarchive={async (id) => {
					await updateThread({ id, archivedAt: null });
				}}
				threads={threads}
			/>
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

const ThreadListSkeleton: FC = () => {
	const skeletonKeys = [
		"skeleton-0",
		"skeleton-1",
		"skeleton-2",
		"skeleton-3",
		"skeleton-4",
	] as const;

	return (
		<div className="flex flex-col gap-1">
			{skeletonKeys.map((key) => (
				<div className="flex h-9 items-center px-3" key={key}>
					<Skeleton className="h-4 w-full" />
				</div>
			))}
		</div>
	);
};

const ThreadListItem: FC<{
	id: Id<"agentSessions">;
	title: string;
	onArchive: () => Promise<void>;
	onDelete: () => Promise<void>;
}> = ({ id, title, onArchive, onDelete }) => {
	const navigate = useNavigate();
	const match = useMatch({
		from: "/_authenticated/chat/$threadId",
		shouldThrow: false,
	});
	const currentThreadId = match?.params.threadId;

	const isActive = currentThreadId === id;

	const handleSelect = () => {
		navigate({
			to: "/chat/$threadId",
			params: { threadId: id },
		});
	};

	const handleArchive = async () => {
		await onArchive();
		if (isActive) {
			navigate({
				to: "/chat",
			});
		}
	};

	const handleDelete = async () => {
		await onDelete();
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

const ArchivedThreadList: FC<{
	threads: ConvexAgentSession[];
	onUnarchive: (id: Id<"agentSessions">) => Promise<void>;
}> = ({ threads, onUnarchive }) => {
	const navigate = useNavigate();
	const archivedThreads = threads.filter(
		(thread) => thread.archivedAt !== null
	);

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
					key={thread._id}
				>
					<button
						className="flex h-full min-w-0 flex-1 items-center truncate px-3 text-start text-muted-foreground text-sm"
						onClick={() =>
							navigate({
								to: "/chat/$threadId",
								params: { threadId: thread._id },
							})
						}
						type="button"
					>
						{thread.title || "New Chat"}
					</button>
					<Button
						className="mr-2 size-7 p-0 opacity-0 transition-opacity group-hover:opacity-100"
						onClick={() => onUnarchive(thread._id)}
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
