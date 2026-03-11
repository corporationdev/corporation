import { useQuery } from "@tanstack/react-query";
import type { SpaceActor } from "@/lib/space-client";

type DesktopTabProps = {
	actor: SpaceActor;
	sandboxId?: string | null;
	spaceSlug: string;
};

export function DesktopTab({ actor, sandboxId, spaceSlug }: DesktopTabProps) {
	const { data: streamUrl, error } = useQuery({
		queryKey: ["desktop-stream", spaceSlug, sandboxId ?? null],
		queryFn: async () => {
			const connection = actor.connection;
			if (!connection) {
				throw new Error("Desktop connection unavailable");
			}
			const url = await connection.getDesktopStreamUrl();
			return url;
		},
		enabled:
			actor.connStatus === "connected" && !!actor.connection && !!sandboxId,
		retry: 3,
		retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
		refetchOnReconnect: true,
		staleTime: Number.POSITIVE_INFINITY,
	});

	if (error) {
		return (
			<div className="flex h-full items-center justify-center text-destructive text-sm">
				Failed to start desktop stream
			</div>
		);
	}

	if (!streamUrl) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				Connecting to desktop...
			</div>
		);
	}

	return (
		<iframe
			allow="clipboard-read; clipboard-write"
			className="h-full w-full border-none"
			src={streamUrl}
			title="Desktop Preview"
		/>
	);
}
