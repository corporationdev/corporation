import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("UserDurableObject", () => {
	it("returns 404 for unknown paths", async () => {
		const id = env.USER_DO.idFromName("test-user");
		const stub = env.USER_DO.get(id);
		const response = await stub.fetch("http://fake/unknown");
		expect(response.status).toBe(404);
	});

	it("rejects runtime socket upgrade without auth", async () => {
		const id = env.USER_DO.idFromName("test-user");
		const stub = env.USER_DO.get(id);
		const response = await stub.fetch("http://fake/runtime/socket", {
			headers: { Upgrade: "websocket" },
		});
		expect(response.status).toBe(401);
	});
});
