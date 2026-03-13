import { describe, expect, test } from "vitest";
import {
	buildRuntimeSocketUrl,
	mintTestRuntimeAccessToken,
	spawnRuntimeCli,
	startWranglerDev,
	waitForEnvironmentDoConnectionCount,
} from "../test/support";

const TEST_USER_ID = "runtime-cli-e2e-user";
const TEST_CLIENT_ID = "runtime-cli-e2e-client";

describe("runtime CLI -> Worker -> Environment DO seam", () => {
	test("connects and disconnects through the runtime socket route", async () => {
		const worker = await startWranglerDev();
		let cli: ReturnType<typeof spawnRuntimeCli> | null = null;

		try {
			const accessToken = await mintTestRuntimeAccessToken({
				userId: TEST_USER_ID,
				clientId: TEST_CLIENT_ID,
			});
			const socketUrl = buildRuntimeSocketUrl({
				serverUrl: worker.serverUrl,
				accessToken,
			});

			cli = spawnRuntimeCli(["connect", "--url", socketUrl]);
			await cli.waitForOutput("Runtime connected");

			const connected = await waitForEnvironmentDoConnectionCount({
				serverUrl: worker.serverUrl,
				environmentKey: TEST_USER_ID,
				expectedCount: 1,
			});
			expect(connected.connections).toHaveLength(1);
			expect(connected.connections[0]?.userId).toBe(TEST_USER_ID);
			expect(connected.connections[0]?.clientId).toBe(TEST_CLIENT_ID);
			expect(connected.connections[0]?.lastSeenAt).not.toBeNull();
			expect(connected.connections[0]?.lastSeenAt).toBeGreaterThanOrEqual(
				connected.connections[0]?.connectedAt ?? 0
			);

			await cli.stop();

			const disconnected = await waitForEnvironmentDoConnectionCount({
				serverUrl: worker.serverUrl,
				environmentKey: TEST_USER_ID,
				expectedCount: 0,
			});
			expect(disconnected.connections).toEqual([]);
		} finally {
			if (cli) {
				await cli.stop();
			}
			await worker.stop();
		}

		if (cli) {
			expect(cli.output.stderr).toBe("");
		}
		expect(worker.output.stderr).not.toContain("Unhandled");
	});
});
