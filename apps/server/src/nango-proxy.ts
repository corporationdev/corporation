import { Nango, type ProxyConfiguration } from "@nangohq/node";
import { resolveNangoProviderForHostname } from "./nango-providers";

export type ResolvedNangoConnection = {
	provider: string;
	providerConfigKey: string;
	connectionId: string;
};

type ConnectionSummary = {
	provider?: string;
	provider_config_key?: string;
	connection_id?: string;
	created?: string;
};

function compareCreatedDesc(a: ConnectionSummary, b: ConnectionSummary): number {
	return Date.parse(b.created ?? "") - Date.parse(a.created ?? "");
}

export async function resolveNangoConnectionForHostname(
	hostname: string,
	userId: string,
	env: Env,
	options?: {
		resolveProvider?: (hostname: string, env: Env) => Promise<string | null>;
		listConnections?: (userId: string) => Promise<{ connections: ConnectionSummary[] }>;
	}
): Promise<ResolvedNangoConnection | null> {
	const provider =
		(await options?.resolveProvider?.(hostname, env)) ??
		(await resolveNangoProviderForHostname(hostname, env));

	if (!provider) {
		return null;
	}

	const connectionsResponse =
		(await options?.listConnections?.(userId)) ??
		(await new Nango({ secretKey: env.NANGO_SECRET_KEY }).listConnections({
			userId,
			limit: 100,
		}));

	const matchingConnection = connectionsResponse.connections
		.filter(
			(connection) =>
				connection.provider?.toLowerCase() === provider &&
				typeof connection.provider_config_key === "string" &&
				typeof connection.connection_id === "string"
		)
		.sort(compareCreatedDesc)[0];

	if (!matchingConnection?.provider_config_key || !matchingConnection.connection_id) {
		return null;
	}

	return {
		provider,
		providerConfigKey: matchingConnection.provider_config_key,
		connectionId: matchingConnection.connection_id,
	};
}

export async function proxyViaNango(
	input: {
		env: Env;
		targetUrl: URL;
		method: string;
		headers: Headers;
		body?: Uint8Array;
		connection: Pick<ResolvedNangoConnection, "providerConfigKey" | "connectionId">;
	}
): Promise<Response> {
	const nango = new Nango({ secretKey: input.env.NANGO_SECRET_KEY });
	const response = await nango.proxy<ArrayBuffer>({
		endpoint: `${input.targetUrl.pathname}${input.targetUrl.search}`,
		method: input.method as ProxyConfiguration["method"],
		providerConfigKey: input.connection.providerConfigKey,
		connectionId: input.connection.connectionId,
		headers: Object.fromEntries(input.headers.entries()),
		data: input.body,
		responseType: "arraybuffer",
	});

	return new Response(response.data, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers as Record<string, string>,
	});
}
