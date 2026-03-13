export type EnvironmentDoRuntimeConnectionsSnapshot = {
	connectionCount: number;
	connections: Array<{
		clientId: string;
		connectedAt: number;
		connectionId: string;
		lastSeenAt: number | null;
		userId: string;
	}>;
};

export function buildEnvironmentDoRuntimeConnectionsUrl(input: {
	serverUrl: string;
	environmentKey: string;
}): string {
	return new URL(
		`/api/test/environment-do/${encodeURIComponent(input.environmentKey)}/runtime-connections`,
		input.serverUrl
	).toString();
}

export async function getEnvironmentDoRuntimeConnections(input: {
	serverUrl: string;
	environmentKey: string;
}): Promise<EnvironmentDoRuntimeConnectionsSnapshot> {
	const response = await fetch(
		buildEnvironmentDoRuntimeConnectionsUrl({
			serverUrl: input.serverUrl,
			environmentKey: input.environmentKey,
		})
	);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch Environment DO runtime connections (${response.status})`
		);
	}
	return (await response.json()) as EnvironmentDoRuntimeConnectionsSnapshot;
}

export async function waitForEnvironmentDoConnectionCount(input: {
	expectedCount: number;
	pollIntervalMs?: number;
	serverUrl: string;
	timeoutMs?: number;
	environmentKey: string;
}): Promise<EnvironmentDoRuntimeConnectionsSnapshot> {
	const timeoutMs = input.timeoutMs ?? 10_000;
	const pollIntervalMs = input.pollIntervalMs ?? 100;
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const snapshot = await getEnvironmentDoRuntimeConnections({
			serverUrl: input.serverUrl,
			environmentKey: input.environmentKey,
		});
		if (snapshot.connectionCount === input.expectedCount) {
			return snapshot;
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error(
		`Timed out waiting for Environment DO connection count ${input.expectedCount} for key ${input.environmentKey}`
	);
}
