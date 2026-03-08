"use node";

import { z } from "zod";

export const CODEX_AUTH_SECRET_NAME = "CODEX_AUTH_JSON";

const codexTokenSchema = z.object({
	id_token: z.string().min(1),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	account_id: z.string().nullable().optional(),
});

const codexAuthJsonSchema = z.object({
	auth_mode: z.literal("chatgpt"),
	OPENAI_API_KEY: z.string().nullable().optional(),
	tokens: codexTokenSchema,
	last_refresh: z.string().min(1),
});

export type CodexAuthJson = z.infer<typeof codexAuthJsonSchema>;

type JwtClaims = {
	email?: string;
	auth?: {
		chatgpt_plan_type?: string;
		chatgpt_account_id?: string;
	};
	profile?: { email?: string };
};

function decodeJwtClaims(jwt: string): JwtClaims {
	const parts = jwt.split(".");
	if (parts.length < 2) {
		throw new Error("Invalid JWT format");
	}

	const payload = Buffer.from(parts[1], "base64url").toString("utf8");
	const json = JSON.parse(payload);
	const parsed = z
		.object({
			email: z.string().optional(),
			profile: z.object({ email: z.string().optional() }).optional(),
			"https://api.openai.com/auth": z
				.object({
					chatgpt_plan_type: z.string().optional(),
					chatgpt_account_id: z.string().optional(),
				})
				.optional(),
		})
		.parse(json);

	return {
		email: parsed.email,
		profile: parsed.profile,
		auth: parsed["https://api.openai.com/auth"],
	};
}

export function parseCodexAuthJson(authJson: string): {
	email: string | null;
	accountId: string | null;
	planType: string | null;
	lastRefresh: string;
	value: CodexAuthJson;
} {
	const value = codexAuthJsonSchema.parse(JSON.parse(authJson));
	const claims = decodeJwtClaims(value.tokens.id_token);

	return {
		email: claims.email ?? claims.profile?.email ?? null,
		accountId:
			value.tokens.account_id ?? claims.auth?.chatgpt_account_id ?? null,
		planType: claims.auth?.chatgpt_plan_type ?? null,
		lastRefresh: value.last_refresh,
		value,
	};
}

export function buildCodexAuthHint(args: {
	email: string | null;
	accountId: string | null;
	planType: string | null;
}): string {
	if (args.email && args.planType) {
		return `${args.email} · ${args.planType}`;
	}
	if (args.email) {
		return args.email;
	}
	if (args.accountId && args.planType) {
		return `${args.accountId} · ${args.planType}`;
	}
	return "Connected";
}

export function decodeCodexAuthImportPayload(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("{")) {
		return trimmed;
	}

	const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
	const padding =
		normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));

	return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}
