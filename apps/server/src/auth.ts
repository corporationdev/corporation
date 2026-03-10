import { bearerAuth } from "hono/bearer-auth";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const jwtPayloadSchema = z.object({
	sub: z.string(),
	email: z.string(),
	name: z.string(),
	sessionId: z.string(),
});

export type JWTPayload = z.infer<typeof jwtPayloadSchema>;

export type AuthVariables = {
	jwtPayload: JWTPayload;
};

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

export async function verifyAuthToken(
	token: string,
	convexSiteUrl: string
): Promise<JWTPayload | null> {
	try {
		const jwks = getJWKS(convexSiteUrl);
		const { payload } = await jwtVerify(token, jwks);
		const result = jwtPayloadSchema.safeParse(payload);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

export const authMiddleware = bearerAuth({
	verifyToken: async (token, c) => {
		const payload = await verifyAuthToken(token, c.env.CONVEX_SITE_URL);
		if (!payload) {
			return false;
		}
		c.set("jwtPayload", payload);
		return true;
	},
});
