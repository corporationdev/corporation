import { useQuery } from "@tanstack/react-query";
import type { SpaceActor } from "@/lib/rivetkit";

type DesktopTabProps = {
	actor: SpaceActor;
};

export function DesktopTab({ actor }: DesktopTabProps) {
	const { data: streamUrl, error } = useQuery({
		queryKey: ["desktop-stream", actor.connStatus],
		queryFn: async () => {
			const connection = actor.connection;
			if (!connection) {
				throw new Error("Desktop connection unavailable");
			}
			const url = await connection.getDesktopStreamUrl();
			return url;
		},
		enabled: actor.connStatus === "connected" && !!actor.connection,
		retry: false,
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
