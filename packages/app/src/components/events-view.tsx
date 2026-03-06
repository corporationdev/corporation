import type { SessionEvent } from "@corporation/shared/session-protocol";
import {
	BotIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClipboardIcon,
	type LucideIcon,
	MessageSquareIcon,
	RadioIcon,
	WrenchIcon,
} from "lucide-react";
import { type FC, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type EventMeta = {
	method: string;
	updateType: string | null;
	updateStatus: string | null;
	toolCallId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	return value as Record<string, unknown>;
}

function parseEventMeta(event: SessionEvent): EventMeta {
	const payload = asRecord(event.payload);
	const method =
		typeof payload?.method === "string" ? payload.method : "(response)";
	const params = asRecord(payload?.params);
	const update = asRecord(params?.update);

	return {
		method,
		updateType:
			typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null,
		updateStatus: typeof update?.status === "string" ? update.status : null,
		toolCallId:
			typeof update?.toolCallId === "string" ? update.toolCallId : null,
	};
}

function getEventIcon(meta: EventMeta): LucideIcon {
	if (meta.method === "session/prompt") {
		return MessageSquareIcon;
	}
	if (meta.method === "session/update") {
		if (
			meta.updateType === "tool_call" ||
			meta.updateType === "tool_call_update"
		) {
			return WrenchIcon;
		}
		if (
			meta.updateType === "agent_message_chunk" ||
			meta.updateType === "agent_thought_chunk"
		) {
			return BotIcon;
		}
	}
	return RadioIcon;
}

function formatPayload(payload: unknown): string {
	try {
		return JSON.stringify(
			payload,
			(_key, value) => (typeof value === "bigint" ? String(value) : value),
			2
		);
	} catch {
		return String(payload);
	}
}

function formatDateTime(timestamp: number): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return "Invalid timestamp";
	}
	return date.toLocaleString();
}

function shortId(id: string): string {
	if (id.length <= 16) {
		return id;
	}
	return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

function badgeClass(value: string): string {
	if (value === "agent") {
		return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
	}
	if (value === "client") {
		return "border-amber-500/40 bg-amber-500/10 text-amber-300";
	}
	if (value.includes("tool")) {
		return "border-orange-500/40 bg-orange-500/10 text-orange-300";
	}
	if (value.includes("session")) {
		return "border-cyan-500/40 bg-cyan-500/10 text-cyan-300";
	}
	return "border-muted-foreground/30 bg-muted text-muted-foreground";
}

const EventItem: FC<{ event: SessionEvent }> = ({ event }) => {
	const [expanded, setExpanded] = useState(false);
	const meta = useMemo(() => parseEventMeta(event), [event]);
	const payload = useMemo(() => formatPayload(event.payload), [event.payload]);
	const payloadPreview = useMemo(() => {
		const collapsed = payload.replace(/\s+/g, " ").trim();
		if (collapsed.length <= 160) {
			return collapsed;
		}
		return `${collapsed.slice(0, 160)}...`;
	}, [payload]);
	const Icon = getEventIcon(meta);

	return (
		<div className="overflow-hidden rounded-md border border-border bg-card/40">
			<button
				className="grid w-full grid-cols-[auto_1fr_auto] gap-3 p-3 text-left hover:bg-muted/40"
				onClick={() => setExpanded((current) => !current)}
				type="button"
			>
				<span className="mt-0.5 inline-flex size-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
					<Icon className="size-4" />
				</span>
				<span className="min-w-0 space-y-1">
					<span className="flex flex-wrap items-center gap-2">
						<span
							className={`rounded border px-2 py-0.5 font-medium text-[11px] uppercase tracking-wide ${badgeClass(meta.method)}`}
						>
							{meta.method}
						</span>
						<span
							className={`rounded border px-2 py-0.5 font-medium text-[11px] uppercase tracking-wide ${badgeClass(event.sender)}`}
						>
							{event.sender}
						</span>
						{meta.updateType && (
							<span className="rounded border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-medium text-[11px] text-violet-300 uppercase tracking-wide">
								{meta.updateType}
							</span>
						)}
					</span>
					<span className="block truncate font-mono text-[11px] text-muted-foreground">
						#{event.eventIndex} {shortId(event.id)}
					</span>
					<span className="block text-muted-foreground text-xs">
						{formatDateTime(event.createdAt)}
					</span>
					{!expanded && (
						<span className="block truncate font-mono text-[11px] text-muted-foreground/80">
							{payloadPreview}
						</span>
					)}
				</span>
				<span className="inline-flex items-start justify-end text-muted-foreground">
					{expanded ? (
						<ChevronDownIcon className="size-4" />
					) : (
						<ChevronRightIcon className="size-4" />
					)}
				</span>
			</button>
			{expanded && (
				<div className="space-y-3 border-border border-t p-3">
					<dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
						<div>
							<dt className="text-muted-foreground">Event ID</dt>
							<dd className="truncate font-mono text-[11px]" title={event.id}>
								{event.id}
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Event Index</dt>
							<dd className="font-mono text-[11px]">{event.eventIndex}</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Update Status</dt>
							<dd className="font-mono text-[11px]">
								{meta.updateStatus ?? "-"}
							</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Tool Call ID</dt>
							<dd
								className="truncate font-mono text-[11px]"
								title={meta.toolCallId ?? ""}
							>
								{meta.toolCallId ?? "-"}
							</dd>
						</div>
					</dl>
					<pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-5">
						{payload}
					</pre>
				</div>
			)}
		</div>
	);
};

export const EventsView: FC<{
	events: SessionEvent[];
	onBack: () => void;
}> = ({ events, onBack }) => {
	const sortedEvents = useMemo(() => [...events].reverse(), [events]);
	const summary = useMemo(() => {
		let client = 0;
		let agent = 0;
		const methods = new Set<string>();
		for (const event of events) {
			if (event.sender === "client") {
				client += 1;
			} else {
				agent += 1;
			}
			methods.add(parseEventMeta(event).method);
		}
		return {
			client,
			agent,
			methodCount: methods.size,
		};
	}, [events]);

	const handleCopy = () => {
		const text = JSON.stringify(events, null, 2);
		navigator.clipboard
			.writeText(text)
			.then(() => {
				toast.success("Events copied to clipboard");
			})
			.catch(() => {
				toast.error("Failed to copy events");
			});
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="flex shrink-0 items-center justify-between border-border border-b px-4 py-2">
				<div className="font-medium text-sm">{events.length} events</div>
				<div className="flex items-center gap-1">
					<Button
						disabled={events.length === 0}
						onClick={handleCopy}
						size="sm"
						variant="ghost"
					>
						<ClipboardIcon className="mr-1.5 size-3.5" />
						Copy JSON
					</Button>
					<Button
						onClick={onBack}
						size="sm"
						title="Back to chat"
						variant="ghost"
					>
						<MessageSquareIcon className="mr-1.5 size-3.5" />
						Chat
					</Button>
				</div>
			</div>

			{events.length === 0 ? (
				<div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
					No events yet.
				</div>
			) : (
				<>
					<div className="flex shrink-0 flex-wrap gap-2 border-border border-b px-4 py-2 text-xs">
						<span className="rounded border border-border bg-muted/50 px-2 py-1">
							Total: {events.length}
						</span>
						<span className="rounded border border-border bg-muted/50 px-2 py-1">
							Agent: {summary.agent}
						</span>
						<span className="rounded border border-border bg-muted/50 px-2 py-1">
							Client: {summary.client}
						</span>
						<span className="rounded border border-border bg-muted/50 px-2 py-1">
							Methods: {summary.methodCount}
						</span>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto p-4">
						<div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
							{sortedEvents.map((event) => (
								<EventItem event={event} key={event.id} />
							))}
						</div>
					</div>
				</>
			)}
		</div>
	);
};
