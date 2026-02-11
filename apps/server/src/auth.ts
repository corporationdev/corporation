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

export const authMiddleware = bearerAuth({
	verifyToken: async (token, c) => {
		try {
			const jwks = getJWKS(c.env.CONVEX_SITE_URL);
			const { payload } = await jwtVerify(token, jwks);
			const result = jwtPayloadSchema.safeParse(payload);
			if (!result.success) {
				return false;
			}
			c.set("jwtPayload", result.data);
			return true;
		} catch {
			return false;
		}
	},
});
