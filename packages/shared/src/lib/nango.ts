import { Nango } from "@nangohq/node";

const GITHUB_PROVIDER_KEY = "github";

export async function getGitHubToken(
	nangoSecretKey: string,
	userId: string
): Promise<string> {
	const nango = new Nango({ secretKey: nangoSecretKey });
	const { connections } = await nango.listConnections({ userId });

	const conn = connections.find(
		(c) => c.provider_config_key === GITHUB_PROVIDER_KEY
	);

	if (!conn) {
		throw new Error("No GitHub connection found for this user");
	}

	const token = await nango.getToken(GITHUB_PROVIDER_KEY, conn.connection_id);

	if (typeof token !== "string") {
		throw new Error("Unexpected token format for GitHub connection");
	}

	return token;
}
