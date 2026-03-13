import { z } from "zod";

const RUNTIME_CLIENT_TYPE = "sandbox_runtime" as const;
const RUNTIME_REFRESH_AUDIENCE = "space-runtime-refresh" as const;
const RUNTIME_ACCESS_AUDIENCE = "space-runtime-access" as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const runtimeClientTypeSchema = z.literal(RUNTIME_CLIENT_TYPE);
export type RuntimeClientType = z.infer<typeof runtimeClientTypeSchema>;

const runtimeTokenBaseClaimsSchema = z.object({
	sub: z.string().min(1),
	sandboxId: z.string().min(1),
	clientType: runtimeClientTypeSchema,
});

export const runtimeRefreshTokenClaimsSchema =
	runtimeTokenBaseClaimsSchema.extend({
		tokenType: z.literal("refresh"),
		aud: z.literal(RUNTIME_REFRESH_AUDIENCE),
		exp: z.number().int().positive(),
	});
export type RuntimeRefreshTokenClaims = z.infer<
	typeof runtimeRefreshTokenClaimsSchema
>;

export const runtimeAccessTokenClaimsSchema =
	runtimeTokenBaseClaimsSchema.extend({
		tokenType: z.literal("access"),
		aud: z.literal(RUNTIME_ACCESS_AUDIENCE),
		exp: z.number().int().positive(),
	});
export type RuntimeAccessTokenClaims = z.infer<
	typeof runtimeAccessTokenClaimsSchema
>;

export const runtimeAuthSessionRequestSchema = z.object({
	refreshToken: z.string().min(1),
});
export type RuntimeAuthSessionRequest = z.infer<
	typeof runtimeAuthSessionRequestSchema
>;

export const runtimeAuthSessionResponseSchema = z.object({
	accessToken: z.string().min(1),
	websocketUrl: z.url(),
	expiresAt: z.number().int().positive(),
});
export type RuntimeAuthSessionResponse = z.infer<
	typeof runtimeAuthSessionResponseSchema
>;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll(/=+$/g, "");
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
	const padded = value
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer;
}

async function signToken(
	claims: RuntimeRefreshTokenClaims | RuntimeAccessTokenClaims,
	secret: string
): Promise<string> {
	const header = bytesToBase64Url(
		encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
	);
	const payload = bytesToBase64Url(
		encoder.encode(
			JSON.stringify({
				sub: claims.sub,
				sandboxId: claims.sandboxId,
				clientType: claims.clientType,
				tokenType: claims.tokenType,
				aud: claims.aud,
				exp: claims.exp,
				iat: Math.floor(Date.now() / 1000),
			})
		)
	);
	const signingInput = `${header}.${payload}`;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(signingInput)
	);
	return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function mintRuntimeRefreshToken(
	claims: Omit<RuntimeRefreshTokenClaims, "aud" | "clientType" | "tokenType">,
	secret: string
): Promise<string> {
	return await signToken(
		{
			...claims,
			aud: RUNTIME_REFRESH_AUDIENCE,
			clientType: RUNTIME_CLIENT_TYPE,
			tokenType: "refresh",
		},
		secret
	);
}

export async function mintRuntimeAccessToken(
	claims: Omit<RuntimeAccessTokenClaims, "aud" | "clientType" | "tokenType">,
	secret: string
): Promise<string> {
	return await signToken(
		{
			...claims,
			aud: RUNTIME_ACCESS_AUDIENCE,
			clientType: RUNTIME_CLIENT_TYPE,
			tokenType: "access",
		},
		secret
	);
}

async function verifyToken<T extends z.ZodTypeAny>(
	token: string,
	secret: string,
	audience: string,
	schema: T
): Promise<z.infer<T> | null> {
	try {
		const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
		if (!(encodedHeader && encodedPayload && encodedSignature)) {
			return null;
		}
		const signingInput = `${encodedHeader}.${encodedPayload}`;
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"]
		);
		const verified = await crypto.subtle.verify(
			"HMAC",
			key,
			base64UrlToArrayBuffer(encodedSignature),
			encoder.encode(signingInput)
		);
		if (!verified) {
			return null;
		}
		const payload = JSON.parse(
			decoder.decode(new Uint8Array(base64UrlToArrayBuffer(encodedPayload)))
		) as Record<string, unknown>;
		const now = Math.floor(Date.now() / 1000);
		if (
			typeof payload.exp !== "number" ||
			payload.exp <= now ||
			payload.aud !== audience
		) {
			return null;
		}
		const result = schema.safeParse({
			sub: payload.sub,
			sandboxId: payload.sandboxId,
			clientType: payload.clientType,
			tokenType: payload.tokenType,
			aud: payload.aud,
			exp: payload.exp,
		});
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

export async function verifyRuntimeRefreshToken(
	token: string,
	secret: string
): Promise<RuntimeRefreshTokenClaims | null> {
	return await verifyToken(
		token,
		secret,
		RUNTIME_REFRESH_AUDIENCE,
		runtimeRefreshTokenClaimsSchema
	);
}

export async function verifyRuntimeAccessToken(
	token: string,
	secret: string
): Promise<RuntimeAccessTokenClaims | null> {
	return await verifyToken(
		token,
		secret,
		RUNTIME_ACCESS_AUDIENCE,
		runtimeAccessTokenClaimsSchema
	);
}

export {
	RUNTIME_ACCESS_AUDIENCE,
	RUNTIME_CLIENT_TYPE,
	RUNTIME_REFRESH_AUDIENCE,
};
