import { describe, expect, test } from "bun:test";
import { mintRuntimeRefreshToken } from "@corporation/contracts/runtime-auth";
import { createRuntimeAuthSession } from "../src/services/runtime-auth";

const RUNTIME_AUTH_SECRET = "test-runtime-auth-secret";

describe("createRuntimeAuthSession", () => {
	test("uses CORPORATION_SERVER_URL for the runtime websocket origin", async () => {
		const refreshToken = await mintRuntimeRefreshToken(
			{
				sub: "user-123",
				spaceSlug: "space-123",
				sandboxId: "sandbox-123",
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			RUNTIME_AUTH_SECRET
		);

		const session = await createRuntimeAuthSession(
			{
				CORPORATION_RUNTIME_AUTH_SECRET: RUNTIME_AUTH_SECRET,
				CORPORATION_SERVER_URL: "https://server-dev.corporation.dev/api",
			} as Env,
			"http://127.0.0.1:59561/api/rpc",
			{
				spaceSlug: "space-123",
				refreshToken,
			}
		);

		const websocketUrl = new URL(session.websocketUrl);
		expect(websocketUrl.origin).toBe("wss://server-dev.corporation.dev");
		expect(websocketUrl.pathname).toBe("/api/spaces/space-123/runtime/socket");
		expect(websocketUrl.searchParams.get("token")).toBe(session.accessToken);
	});

	test("falls back to the request origin when CORPORATION_SERVER_URL is missing", async () => {
		const refreshToken = await mintRuntimeRefreshToken(
			{
				sub: "user-123",
				spaceSlug: "space-123",
				sandboxId: "sandbox-123",
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			RUNTIME_AUTH_SECRET
		);

		const session = await createRuntimeAuthSession(
			{
				CORPORATION_RUNTIME_AUTH_SECRET: RUNTIME_AUTH_SECRET,
			} as Env,
			"http://127.0.0.1:59561/api/rpc",
			{
				spaceSlug: "space-123",
				refreshToken,
			}
		);

		const websocketUrl = new URL(session.websocketUrl);
		expect(websocketUrl.origin).toBe("ws://127.0.0.1:59561");
		expect(websocketUrl.pathname).toBe("/api/spaces/space-123/runtime/socket");
		expect(websocketUrl.searchParams.get("token")).toBe(session.accessToken);
	});
});
