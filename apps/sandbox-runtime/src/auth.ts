import { bearerAuth } from "hono/bearer-auth";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { rememberVerifiedAuthToken } from "./auth-state";

const runtimeJwtPayloadSchema = z.object({
	sub: z.string(),
	email: z.string(),
	name: z.string(),
	sessionId: z.string(),
});

export type RuntimeJWTPayload = z.infer<typeof runtimeJwtPayloadSchema>;

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJWKSUrl: string | null = null;

function getJWKS(convexSiteUrl: string) {
	const jwksUrl = `${convexSiteUrl}/api/auth/convex/jwks`;
	if (cachedJWKS && cachedJWKSUrl === jwksUrl) {
		return cachedJWKS;
	}
	cachedJWKS = createRemoteJWKSet(new URL(jwksUrl));
	cachedJWKSUrl = jwksUrl;
	return cachedJWKS;
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

const convexSiteUrl = requireEnv("CORPORATION_CONVEX_SITE_URL");
const ownerUserId = requireEnv("CORPORATION_SANDBOX_OWNER_ID");

export const runtimeAuthMiddleware = bearerAuth({
	verifyToken: async (token) => {
		try {
			const jwks = getJWKS(convexSiteUrl);
			const { payload } = await jwtVerify(token, jwks);
			const result = runtimeJwtPayloadSchema.safeParse(payload);
			if (!result.success || result.data.sub !== ownerUserId) {
				return false;
			}
			rememberVerifiedAuthToken(token, result.data);
			return true;
		} catch {
			return false;
		}
	},
});
