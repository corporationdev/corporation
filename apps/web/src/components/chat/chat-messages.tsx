import { code } from "@streamdown/code";
import {
	AlertTriangleIcon,
	BrainIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	InfoIcon,
	WrenchIcon,
} from "lucide-react";
import { type RefObject, useState } from "react";
import { Streamdown } from "streamdown";
import type {
	MessageTimelineEntry,
	MetaTimelineEntry,
	ReasoningTimelineEntry,
	TimelineEntry,
	ToolTimelineEntry,
} from "@/components/chat/types";
import { cn } from "@/lib/utils";

type ToolGroupEntry =
	| ToolTimelineEntry
	| ReasoningTimelineEntry
	| MetaTimelineEntry;
type GroupedEntries =
	| {
			type: "message";
			entries: [MessageTimelineEntry];
	  }
	| {
			type: "tool-group";
			entries: ToolGroupEntry[];
	  };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tool rendering requires checking multiple entry kinds and states
function ToolItem({
	entry,
	isLast,
}: {
	entry: ToolGroupEntry;
	isLast: boolean;
}) {
	const [expanded, setExpanded] = useState(false);

	const isTool = entry.kind === "tool";
	const isReasoning = entry.kind === "reasoning";

	const isFailed = isTool && entry.toolStatus === "failed";
	const isInProgress = isTool && entry.toolStatus === "in_progress";

	let label = "";
	let icon = <InfoIcon className="size-3 shrink-0" />;

	if (isTool) {
		const statusLabel =
			entry.toolStatus !== "completed"
				? ` (${entry.toolStatus.replace("_", " ")})`
				: "";
		label = `${entry.toolName ?? "tool"}${statusLabel}`;
		icon = <WrenchIcon className="size-3 shrink-0" />;
	} else if (isReasoning) {
		label = `Reasoning${entry.reasoning.visibility ? ` (${entry.reasoning.visibility})` : ""}`;
		icon = <BrainIcon className="size-3 shrink-0" />;
	} else {
		label = entry.meta.title;
		icon =
			entry.meta.severity === "error" ? (
				<AlertTriangleIcon className="size-3 shrink-0" />
			) : (
				<InfoIcon className="size-3 shrink-0" />
			);
	}

	const hasContent = isTool
		? Boolean(entry.toolInput || entry.toolOutput)
		: isReasoning
			? Boolean(entry.reasoning.text.trim())
			: Boolean(entry.meta.detail?.trim());

	return (
		<div className="flex gap-2">
			<div className="flex w-4 flex-col items-center">
				<div
					className={cn(
						"mt-2 size-1.5 rounded-full",
						isFailed ? "bg-destructive" : "bg-muted-foreground/40"
					)}
				/>
				{!isLast && <div className="w-px flex-1 bg-muted-foreground/20" />}
			</div>
			<div className="min-w-0 flex-1 pb-1">
				<button
					className={cn(
						"flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground text-xs transition-colors",
						hasContent && "hover:bg-muted hover:text-foreground"
					)}
					disabled={!hasContent}
					onClick={() => hasContent && setExpanded(!expanded)}
					type="button"
				>
					{icon}
					<span className="truncate">{label}</span>
					{isInProgress && <ThinkingDots />}
					{hasContent && (
						<span className="ml-auto shrink-0">
							{expanded ? (
								<ChevronDownIcon className="size-3" />
							) : (
								<ChevronRightIcon className="size-3" />
							)}
						</span>
					)}
				</button>
				{expanded && hasContent && (
					<div className="mt-1 space-y-2 pl-1">
						{isTool && entry.toolInput && (
							<div>
								<div className="mb-0.5 font-medium text-muted-foreground text-xs">
									Input
								</div>
								<pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
									{entry.toolInput}
								</pre>
							</div>
						)}
						{isTool && entry.toolOutput && (
							<div>
								<div className="mb-0.5 font-medium text-muted-foreground text-xs">
									Output
								</div>
								<pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
									{entry.toolOutput}
								</pre>
							</div>
						)}
						{isReasoning && entry.reasoning.text && (
							<pre className="overflow-x-auto rounded bg-muted p-2 text-muted-foreground text-xs">
								{entry.reasoning.text}
							</pre>
						)}
						{entry.kind === "meta" && entry.meta.detail && (
							<pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
								{entry.meta.detail}
							</pre>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function ToolGroup({ entries }: { entries: ToolGroupEntry[] }) {
	const [expanded, setExpanded] = useState(false);

	if (entries.length === 1) {
		return (
			<div className="mx-auto w-full max-w-[44rem] px-2 py-1">
				<ToolItem entry={entries[0]} isLast />
			</div>
		);
	}

	const summary = `${entries.length} Events`;
	const hasFailed = entries.some(
		(e) => e.kind === "tool" && e.toolStatus === "failed"
	);

	return (
		<div className="mx-auto w-full max-w-[44rem] px-2 py-1">
			<button
				className={cn(
					"flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground",
					hasFailed && "text-destructive"
				)}
				onClick={() => setExpanded(!expanded)}
				type="button"
			>
				<span>{summary}</span>
				{expanded ? (
					<ChevronDownIcon className="size-3" />
				) : (
					<ChevronRightIcon className="size-3" />
				)}
			</button>
			{expanded && (
				<div className="mt-1 pl-1">
					{entries.map((entry, idx) => (
						<ToolItem
							entry={entry}
							isLast={idx === entries.length - 1}
							key={entry.id}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ThinkingDots() {
	return (
		<span className="inline-flex items-center gap-0.5">
			<span className="size-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
			<span className="size-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
			<span className="size-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
		</span>
	);
}

export function ChatMessages({
	entries,
	isThinking,
	messagesEndRef,
}: {
	entries: TimelineEntry[];
	isThinking?: boolean;
	messagesEndRef: RefObject<HTMLDivElement | null>;
}) {
	const groupedEntries: GroupedEntries[] = [];

	let currentToolGroup: ToolGroupEntry[] = [];

	const flushToolGroup = () => {
		if (currentToolGroup.length > 0) {
			groupedEntries.push({
				type: "tool-group",
				entries: currentToolGroup,
			});
			currentToolGroup = [];
		}
	};

	for (const entry of entries) {
		if (
			entry.kind === "tool" ||
			entry.kind === "reasoning" ||
			entry.kind === "meta"
		) {
			currentToolGroup.push(entry);
		} else {
			flushToolGroup();
			groupedEntries.push({ type: "message", entries: [entry] });
		}
	}
	flushToolGroup();

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4">
			{groupedEntries.map((group) => {
				if (group.type === "tool-group") {
					return (
						<ToolGroup entries={group.entries} key={group.entries[0].id} />
					);
				}

				const entry = group.entries[0];
				const isUser = entry.role === "user";
				const isLastEntry = group === groupedEntries.at(-1);

				return (
					<div
						className={cn(
							"mx-auto w-full max-w-[44rem] py-3",
							isUser && "flex justify-end"
						)}
						key={entry.id}
					>
						{isUser ? (
							<div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm">
								{entry.text ?? ""}
							</div>
						) : (
							<div className="wrap-break-word px-2 text-sm leading-relaxed">
								{entry.text ? (
									<Streamdown
										isAnimating={isLastEntry && isThinking}
										plugins={{ code }}
									>
										{entry.text}
									</Streamdown>
								) : (
									<ThinkingDots />
								)}
							</div>
						)}
					</div>
				);
			})}
			{isThinking && (
				<div className="mx-auto w-full max-w-[44rem] py-3">
					<div className="px-2 text-muted-foreground">
						<ThinkingDots />
					</div>
				</div>
			)}
			<div ref={messagesEndRef} />
		</div>
	);
}
