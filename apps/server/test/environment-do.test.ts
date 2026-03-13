import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("EnvironmentDurableObject", () => {
	it("returns 404 for unknown paths", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("test-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const response = await stub.fetch("http://fake/unknown");
		expect(response.status).toBe(404);
	});

	it("rejects runtime socket upgrade without auth", async () => {
		const id = env.ENVIRONMENT_DO.idFromName("test-user");
		const stub = env.ENVIRONMENT_DO.get(id);
		const response = await stub.fetch("http://fake/runtime/socket", {
			headers: { Upgrade: "websocket" },
		});
		expect(response.status).toBe(401);
	});
});
