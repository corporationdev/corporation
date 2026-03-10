import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRuntimeHarness, type RuntimeHarness } from "./harness";

describe("sandbox-runtime proxy", () => {
	let harness: RuntimeHarness | null = null;

	beforeAll(async () => {
		harness = await createRuntimeHarness();
		await harness.setup();
	}, 300_000);

	afterAll(async () => {
		await harness?.teardown();
	}, 300_000);

	test("starts mitmdump and generates a CA cert", async () => {
		if (!harness) {
			throw new Error("harness not initialized");
		}

		const processResult = await harness.run("pgrep -f mitmdump | head -n 1", 5_000);
		expect(processResult.exitCode).toBe(0);
		const pid = processResult.stdout.trim();
		expect(pid).not.toBe("");

		const commandResult = await harness.run(`ps -p ${pid} -o command=`, 5_000);
		expect(commandResult.stdout).toContain("mitmdump");

		const certResult = await harness.run(
			`test -f ${harness.proxyConfig.caCertPath} && echo ok`,
			5_000
		);
		expect(certResult.stdout.trim()).toBe("ok");
	});

	test("proxies HTTPS traffic for curl", async () => {
		if (!harness) {
			throw new Error("harness not initialized");
		}

		const result = await harness.runWithProxy(
			"curl -sS -o /tmp/proxy-test.html -w '%{http_code}' https://example.com",
			20_000
		);

		if (result.stdout.trim() !== "200") {
			const proxyLog = await harness
				.run("tail -n 50 /tmp/corporation-mitmproxy.log", 5_000)
				.then((output) => output.stdout.trim())
				.catch(() => "");
			const proxyStderr = await harness
				.run("tail -n 50 /tmp/corporation-mitmproxy.stderr.log", 5_000)
				.then((output) => output.stdout.trim())
				.catch(() => "");
			const responseBody = await harness
				.run("cat /tmp/proxy-test.html", 5_000)
				.then((output) => output.stdout.trim())
				.catch(() => "");

			throw new Error(
				[
					`expected 200 from proxied curl, got ${result.stdout.trim() || "<empty>"}`,
					result.stderr ? `curl stderr: ${result.stderr.trim()}` : null,
					responseBody ? `curl body: ${responseBody}` : null,
					proxyLog ? `proxy log:\n${proxyLog}` : null,
					proxyStderr ? `proxy stderr:\n${proxyStderr}` : null,
				]
					.filter(Boolean)
					.join("\n\n")
			);
		}

		expect(result.stdout.trim()).toBe("200");
	});
});

if (process.env.SANDBOX_RUNTIME_TEST_TARGET !== "sandbox") {
	describe("sandbox-runtime proxy worker forwarding", () => {
		let harness: RuntimeHarness | null = null;
		let workerServer: Bun.Server<unknown> | null = null;
		let forwardedPayload:
			| {
					url: string;
					method: string;
					headers?: Record<string, string>;
			  }
			| null = null;

		beforeAll(async () => {
			workerServer = Bun.serve({
				port: 0,
				fetch: async (request) => {
					if (request.method !== "POST" || request.url.indexOf("/api/proxy/http") === -1) {
						return new Response("not found", { status: 404 });
					}

					forwardedPayload = (await request.json()) as typeof forwardedPayload;

					return new Response("worker-forwarded", {
						status: 200,
						headers: {
							"content-type": "text/plain",
							"x-worker-forwarded": "yes",
						},
					});
				},
			});

			harness = await createRuntimeHarness({
				runtimeEnv: {
					CORPORATION_PROXY_WORKER_URL: `http://127.0.0.1:${workerServer.port}/api/proxy/http`,
					CORPORATION_PROXY_MATCH_HOSTS: "forward.test",
				},
			});
			await harness.setup();
		}, 300_000);

		afterAll(async () => {
			await harness?.teardown();
			await workerServer?.stop(true);
		}, 300_000);

		test("forwards matched hosts through the worker route", async () => {
			if (!harness) {
				throw new Error("harness not initialized");
			}

			const result = await harness.runWithProxy(
				"curl -sS --noproxy '' http://forward.test/worker-path?hello=world",
				20_000
			);

			expect(result.stdout.trim()).toBe("worker-forwarded");
			expect(forwardedPayload).not.toBeNull();
			expect(forwardedPayload?.url).toBe(
				"http://forward.test/worker-path?hello=world"
			);
			expect(forwardedPayload?.method).toBe("GET");
		});
	});
}
