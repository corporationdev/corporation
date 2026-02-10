import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient, getAuthHeaders } from "@/lib/api-client";

export const Route = createFileRoute("/_authenticated/settings/connections")({
	component: ConnectionsPage,
});

async function fetchIntegrations() {
	const res = await apiClient.integrations.$get(
		{},
		{ headers: await getAuthHeaders() }
	);
	if (!res.ok) {
		throw new Error("Failed to fetch integrations");
	}
	const data = await res.json();
	return data.configs;
}

function ConnectionsPage() {
	const {
		data: integrations,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["integrations"],
		queryFn: fetchIntegrations,
	});
	const connectMutation = useMutation({
		mutationFn: async (uniqueKey: string) => {
			const res = await apiClient.integrations.connect.$post(
				{
					json: {
						allowed_integrations: [uniqueKey],
					},
				},
				{ headers: await getAuthHeaders() }
			);

			if (!res.ok) {
				throw new Error("Failed to create connect session");
			}

			const { connect_link } = await res.json();
			if (connect_link) {
				window.open(connect_link, "_blank");
			}
		},
	});

	return (
		<div className="p-6">
			<h1 className="font-semibold text-lg">Connections</h1>
			<p className="mt-1 mb-4 text-muted-foreground text-sm">
				Manage your connected services and integrations.
			</p>

			{error && (
				<p className="mb-4 text-destructive text-sm">{error.message}</p>
			)}

			{isLoading ? (
				<div className="flex flex-col gap-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : integrations?.length ? (
				<div className="flex flex-col gap-3">
					{integrations.map((integration) => (
						<Card key={integration.unique_key} size="sm">
							<CardHeader>
								<div className="flex items-center gap-2">
									{integration.logo && (
										<img
											alt={`${integration.provider} logo`}
											className="size-5"
											height={20}
											src={integration.logo}
											width={20}
										/>
									)}
									<div>
										<CardTitle>{integration.provider}</CardTitle>
										<CardDescription>{integration.unique_key}</CardDescription>
									</div>
								</div>
								<CardAction>
									<Button
										disabled={connectMutation.isPending}
										onClick={() =>
											connectMutation.mutate(integration.unique_key)
										}
										size="sm"
										variant="outline"
									>
										{connectMutation.isPending &&
										connectMutation.variables === integration.unique_key
											? "Connecting..."
											: "Connect"}
									</Button>
								</CardAction>
							</CardHeader>
						</Card>
					))}
				</div>
			) : (
				<p className="text-muted-foreground text-sm">
					No integrations available.
				</p>
			)}
		</div>
	);
}
