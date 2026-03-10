import { afterEach, describe, expect, test } from "bun:test";
import {
	clearNangoProviderCacheForTests,
	resolveNangoProviderForHostname,
} from "../src/nango-providers";
import { resolveNangoConnectionForHostname } from "../src/nango-proxy";

const env = {
	NANGO_SECRET_KEY: "test",
	CONVEX_SITE_URL: "https://example.convex.cloud",
} as Env;

afterEach(() => {
	clearNangoProviderCacheForTests();
});

describe("Nango provider registry", () => {
	test("resolves a hostname from concrete provider base URLs", async () => {
		const provider = await resolveNangoProviderForHostname(
			"api.github.com",
			env,
			{
				loadProviders: async () => ({
					data: [
						{ name: "github", proxy: { base_url: "https://api.github.com" } },
					],
				}),
			}
		);

		expect(provider).toBe("github");
	});

	test("ignores templated provider base URLs", async () => {
		const provider = await resolveNangoProviderForHostname(
			"acme.my.salesforce.com",
			env,
			{
				loadProviders: async () => ({
					data: [
						{
							name: "salesforce",
							proxy: { base_url: "${connectionConfig.instance_url}" },
						},
					],
				}),
			}
		);

		expect(provider).toBeNull();
	});

	test("caches provider responses within the TTL", async () => {
		let calls = 0;
		const loadProviders = async () => {
			calls += 1;
			return {
				data: [{ name: "github", proxy: { base_url: "https://api.github.com" } }],
			};
		};

		const now = () => 1_000;
		expect(
			await resolveNangoProviderForHostname("api.github.com", env, {
				loadProviders,
				now,
				cacheTtlMs: 60_000,
			})
		).toBe("github");
		expect(
			await resolveNangoProviderForHostname("api.github.com", env, {
				loadProviders,
				now,
				cacheTtlMs: 60_000,
			})
		).toBe("github");

		expect(calls).toBe(1);
	});
});

describe("Nango connection selection", () => {
	test("chooses the newest connection for the resolved provider", async () => {
		const connection = await resolveNangoConnectionForHostname(
			"api.github.com",
			"user-123",
			env,
			{
				resolveProvider: async () => "github",
				listConnections: async () => ({
					connections: [
						{
							provider: "github",
							provider_config_key: "github-prod",
							connection_id: "old-conn",
							created: "2025-01-01T00:00:00.000Z",
						},
						{
							provider: "github",
							provider_config_key: "github-prod",
							connection_id: "new-conn",
							created: "2025-02-01T00:00:00.000Z",
						},
						{
							provider: "slack",
							provider_config_key: "slack-prod",
							connection_id: "slack-conn",
							created: "2025-03-01T00:00:00.000Z",
						},
					],
				}),
			}
		);

		expect(connection).toEqual({
			provider: "github",
			providerConfigKey: "github-prod",
			connectionId: "new-conn",
		});
	});
});
