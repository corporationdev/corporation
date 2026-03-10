import { describe, expect, test } from "bun:test";
import { getLocalProxyConfig } from "../src/proxy-config";

describe("local proxy config", () => {
	test("defaults worker-forwarded traffic to github integration hosts", () => {
		const config = getLocalProxyConfig({});

		expect(config.workerUrl).toBeNull();
		expect(config.workerTokenPath).toBe(
			"/tmp/corporation-mitmproxy/worker-token.txt"
		);
		expect(config.workerForwardHosts).toEqual([
			"api.github.com",
			"uploads.github.com",
		]);
	});

	test("derives the worker route from a root server url", () => {
		const config = getLocalProxyConfig({
			SERVER_URL: "https://app.corporation.dev",
		});

		expect(config.workerUrl).toBe("https://app.corporation.dev/api/proxy");
	});

	test("derives the worker route from an api-prefixed server url", () => {
		const config = getLocalProxyConfig({
			SERVER_URL: "https://app.corporation.dev/api",
		});

		expect(config.workerUrl).toBe("https://app.corporation.dev/api/proxy");
	});
});
