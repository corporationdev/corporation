import type {
	CreateIntegrationConnectSessionInput,
	CreateIntegrationConnectSessionOutput,
	GetIntegrationConnectionOutput,
	ListIntegrationsOutput,
} from "@corporation/contracts/orpc/worker-http";
import { Nango } from "@nangohq/node";

export async function listIntegrations(
	env: Env,
	userId: string
): Promise<ListIntegrationsOutput> {
	const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });
	const [integrationsRes, connectionsData] = await Promise.all([
		nango.listIntegrations(),
		nango.listConnections({ userId }),
	]);

	const connectionsByKey = new Map(
		connectionsData.connections.map((conn) => [conn.provider_config_key, conn])
	);

	return {
		integrations: integrationsRes.configs.map(
			(config: { unique_key: string; provider: string; logo?: string }) => {
				const conn = connectionsByKey.get(config.unique_key);
				return {
					unique_key: config.unique_key,
					provider: config.provider,
					logo: config.logo,
					connection: conn
						? {
								connection_id: conn.connection_id,
								provider: conn.provider,
								created: conn.created,
								end_user: conn.end_user
									? {
											email: conn.end_user.email,
											display_name: conn.end_user.display_name,
										}
									: null,
							}
						: null,
				};
			}
		),
	};
}

export async function getIntegrationConnection(
	env: Env,
	userId: string,
	uniqueKey: string
): Promise<GetIntegrationConnectionOutput> {
	const integrations = await listIntegrations(env, userId);
	return {
		connection:
			integrations.integrations.find(
				(integration) => integration.unique_key === uniqueKey
			)?.connection ?? null,
	};
}

export async function createIntegrationConnectSession(
	env: Env,
	jwtPayload: { sub: string; email: string; name: string },
	input: CreateIntegrationConnectSessionInput
): Promise<CreateIntegrationConnectSessionOutput> {
	const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });
	const { data } = await nango.createConnectSession({
		end_user: {
			id: jwtPayload.sub,
			email: jwtPayload.email,
			display_name: jwtPayload.name,
		},
		allowed_integrations: input.allowedIntegrations,
	});

	return {
		token: data.token,
		connect_link: data.connect_link,
		expires_at: data.expires_at,
	};
}

export async function disconnectIntegration(
	env: Env,
	input: {
		connectionId: string;
		providerConfigKey: string;
	}
): Promise<{ success: true }> {
	const nango = new Nango({ secretKey: env.NANGO_SECRET_KEY });
	await nango.deleteConnection(input.providerConfigKey, input.connectionId);
	return { success: true };
}
