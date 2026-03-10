import { describe, expect, test } from "bun:test";
import { getLocalProxyConfig } from "../src/proxy-config";

describe("local proxy config", () => {
	test("defaults worker-forwarded traffic to github integration hosts", () => {
		const config = getLocalProxyConfig({});

		expect(config.workerUrl).toBeNull();
		expect(config.workerForwardHosts).toEqual([
			"api.github.com",
			"uploads.github.com",
		]);
	});
});
