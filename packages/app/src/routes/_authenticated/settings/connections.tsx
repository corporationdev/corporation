import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { InferResponseType } from "hono/client";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api-client";

export const Route = createFileRoute("/_authenticated/settings/connections")({
	component: ConnectionsPage,
});

type IntegrationsResponse = InferResponseType<
	typeof apiClient.integrations.$get,
	200
>;
type Integration = IntegrationsResponse["integrations"][number];

async function fetchIntegrations() {
	const res = await apiClient.integrations.$get({});
	if (!res.ok) {
		throw new Error("Failed to fetch integrations");
	}
	const data = await res.json();
	return data.integrations;
}

function IntegrationCard({
	integration,
	onConnect,
	onDisconnect,
	isConnecting,
	isDisconnecting,
}: {
	integration: Integration;
	onConnect: (uniqueKey: string) => void;
	onDisconnect: (connectionId: string, providerConfigKey: string) => void;
	isConnecting: boolean;
	isDisconnecting: boolean;
}) {
	const { connection } = integration;

	return (
		<Card size="sm">
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
						<CardDescription>
							{connection
								? `Connected${connection.end_user?.email ? ` as ${connection.end_user.email}` : ""}`
								: "Not connected"}
						</CardDescription>
					</div>
				</div>
				<CardAction>
					{connection ? (
						<Button
							disabled={isDisconnecting}
							onClick={() =>
								onDisconnect(connection.connection_id, integration.unique_key)
							}
							size="sm"
							variant="destructive"
						>
							{isDisconnecting ? "Disconnecting..." : "Disconnect"}
						</Button>
					) : (
						<Button
							disabled={isConnecting}
							onClick={() => onConnect(integration.unique_key)}
							size="sm"
							variant="outline"
						>
							{isConnecting ? "Connecting..." : "Connect"}
						</Button>
					)}
				</CardAction>
			</CardHeader>
		</Card>
	);
}

function ConnectionsPage() {
	const queryClient = useQueryClient();

	const {
		data: integrations,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["integrations"],
		queryFn: fetchIntegrations,
	});

	const disconnectMutation = useMutation({
		mutationFn: async ({
			connectionId,
			providerConfigKey,
		}: {
			connectionId: string;
			providerConfigKey: string;
		}) => {
			const res = await apiClient.integrations.connections[
				":connectionId"
			].$delete({
				param: { connectionId },
				query: { provider_config_key: providerConfigKey },
			});

			if (!res.ok) {
				throw new Error("Failed to disconnect");
			}
		},
		onMutate: async ({ providerConfigKey }) => {
			await queryClient.cancelQueries({ queryKey: ["integrations"] });

			const previous = queryClient.getQueryData<Integration[]>([
				"integrations",
			]);

			queryClient.setQueryData<Integration[]>(["integrations"], (old) =>
				old?.map((i) =>
					i.unique_key === providerConfigKey ? { ...i, connection: null } : i
				)
			);

			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(["integrations"], context.previous);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["integrations"] });
		},
	});

	const connectMutation = useMutation({
		mutationFn: async (uniqueKey: string) => {
			const res = await apiClient.integrations.connect.$post({
				json: {
					allowed_integrations: [uniqueKey],
				},
			});

			if (!res.ok) {
				throw new Error("Failed to create connect session");
			}

			const { connect_link } = await res.json();
			if (connect_link) {
				window.open(connect_link, "_blank");
			}
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["integrations"] });
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
						<IntegrationCard
							integration={integration}
							isConnecting={
								connectMutation.isPending &&
								connectMutation.variables === integration.unique_key
							}
							isDisconnecting={
								disconnectMutation.isPending &&
								disconnectMutation.variables?.providerConfigKey ===
									integration.unique_key
							}
							key={integration.unique_key}
							onConnect={(uniqueKey) => connectMutation.mutate(uniqueKey)}
							onDisconnect={(connectionId, providerConfigKey) =>
								disconnectMutation.mutate({ connectionId, providerConfigKey })
							}
						/>
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
