import { env } from "@corporation/env/server";
import { UserError } from "rivetkit";
import { verifyAuthToken } from "../auth";
import type { SpaceConnectionParams, SpaceConnectionState } from "./types";

export async function createActorAuthState(
	params: SpaceConnectionParams | undefined
): Promise<SpaceConnectionState> {
	const authToken = params?.authToken?.trim();
	if (!authToken) {
		throw new UserError("Unauthorized", { code: "unauthorized" });
	}

	const jwtPayload = await verifyAuthToken(authToken, env.CONVEX_SITE_URL);
	if (!jwtPayload) {
		throw new UserError("Invalid auth token", { code: "unauthorized" });
	}

	return {
		authToken,
		jwtPayload,
	};
}

export function requireActorAuth(c: {
	conn?: { state: SpaceConnectionState };
}): SpaceConnectionState {
	if (!c.conn?.state) {
		throw new Error("Missing actor auth state");
	}

	return c.conn.state;
}

export function createRuntimeAuthHeaders(
	authToken: string
): Record<string, string> {
	const token = authToken.trim();

	return {
		Authorization: `Bearer ${token}`,
	};
}
