import { describe, expect, test } from "bun:test";
import { createApiApp } from "../src/app";

describe("proxy route", () => {
	test("forwards method, headers, and body to the target URL", async () => {
		let forwardedUrl = "";
		let forwardedMethod = "";
		let forwardedHeaders = new Headers();
		let forwardedBody = "";
		const app = createApiApp({
			proxyFetch: async (request) => {
				forwardedUrl = request.url;
				forwardedMethod = request.method;
				forwardedHeaders = new Headers(request.headers);
				forwardedBody = await request.text();
				return new Response("upstream ok", {
					status: 201,
					headers: {
						"content-type": "text/plain",
						"x-upstream": "yes",
					},
				});
			},
		});

		const response = await app.request("/api/proxy/http", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				url: "https://api.example.com/v1/test",
				method: "PATCH",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
					"x-custom": "123",
				},
				bodyBase64: Buffer.from('{"hello":"world"}').toString("base64"),
			}),
		});

		expect(response.status).toBe(201);
		expect(await response.text()).toBe("upstream ok");
		expect(response.headers.get("x-upstream")).toBe("yes");
		expect(forwardedUrl).toBe("https://api.example.com/v1/test");
		expect(forwardedMethod).toBe("PATCH");
		expect(forwardedHeaders.get("authorization")).toBe(
			"Bearer test-token"
		);
		expect(forwardedHeaders.get("x-custom")).toBe("123");
		expect(forwardedBody).toBe('{"hello":"world"}');
	});

	test("rejects unsupported URL schemes", async () => {
		const app = createApiApp();

		const response = await app.request("/api/proxy/http", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				url: "file:///etc/passwd",
				method: "GET",
				headers: {},
			}),
		});

		expect(response.status).toBe(400);
		expect((await response.json()) as { error: string }).toEqual({
			error: "Only http and https URLs are allowed",
		});
	});

	test("strips hop-by-hop request headers before forwarding", async () => {
		let forwardedHeaders = new Headers();
		const app = createApiApp({
			proxyFetch: async (request) => {
				forwardedHeaders = new Headers(request.headers);
				return new Response("ok");
			},
		});

		await app.request("/api/proxy/http", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				url: "https://api.example.com/v1/test",
				method: "GET",
				headers: {
					connection: "keep-alive",
					"proxy-authorization": "secret",
					"x-keep": "yes",
				},
			}),
		});

		expect(forwardedHeaders.get("connection")).toBeNull();
		expect(forwardedHeaders.get("proxy-authorization")).toBeNull();
		expect(forwardedHeaders.get("x-keep")).toBe("yes");
	});

	test("uses the Nango proxy when an authenticated user has a matching connection", async () => {
		let directFetchCalled = false;
		let proxiedTarget = "";
		const app = createApiApp({
			proxyFetch: async () => {
				directFetchCalled = true;
				return new Response("direct");
			},
			resolveUserId: async () => "user-123",
			resolveNangoConnection: async () => ({
				provider: "github",
				providerConfigKey: "github-prod",
				connectionId: "conn-1",
			}),
			proxyViaNango: async ({ targetUrl, connection, method, headers }) => {
				proxiedTarget = targetUrl.toString();
				expect(connection.providerConfigKey).toBe("github-prod");
				expect(connection.connectionId).toBe("conn-1");
				expect(method).toBe("GET");
				expect(headers.get("x-custom")).toBe("abc");
				return new Response("proxied", {
					status: 202,
					headers: { "x-proxied-via": "nango" },
				});
			},
		});

		const response = await app.request("/api/proxy/http", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				url: "https://api.github.com/user",
				method: "GET",
				headers: {
					"x-custom": "abc",
				},
			}),
		});

		expect(directFetchCalled).toBeFalse();
		expect(proxiedTarget).toBe("https://api.github.com/user");
		expect(response.status).toBe(202);
		expect(response.headers.get("x-proxied-via")).toBe("nango");
		expect(await response.text()).toBe("proxied");
	});
});
