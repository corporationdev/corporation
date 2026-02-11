import { bearerAuth } from "hono/bearer-auth";
import type { JWTPayload } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";

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
			c.set("jwtPayload", payload as JWTPayload);
			return true;
		} catch {
			return false;
		}
	},
});
