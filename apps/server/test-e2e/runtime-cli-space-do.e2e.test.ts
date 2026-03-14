import { describe, expect, test } from "vitest";
import {
	buildRuntimeSocketUrl,
	createTestSpaceSession,
	getSpaceSession,
	mintTestRuntimeAccessToken,
	promptTestSpaceSession,
	spawnRuntimeCli,
	startWranglerDev,
	waitForEnvironmentDoConnectionCount,
	waitForSpaceSessionEvents,
} from "../test/support";

const TEST_USER_ID = "runtime-cli-space-do-e2e-user";
const TEST_CLIENT_ID = "runtime-cli-space-do-e2e-client";
const TEST_CWD = new URL("../../../", import.meta.url).pathname.replace(
	/\/$/,
	""
);

describe("runtime CLI -> Environment DO -> Space DO e2e", () => {
	test("creates a session, prompts it, and persists streamed runtime events on the space", async () => {
		const worker = await startWranglerDev();
		let cli: ReturnType<typeof spawnRuntimeCli> | null = null;
		const timestamp = Date.now();
		const spaceName = `space-e2e-${timestamp}`;
		const sessionId = `session-e2e-${timestamp}`;

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
			await cli.waitForOutput("Runtime connected", 60_000);

			await waitForEnvironmentDoConnectionCount({
				serverUrl: worker.serverUrl,
				environmentKey: TEST_USER_ID,
				expectedCount: 1,
				timeoutMs: 30_000,
			});

			const createSessionResult = await createTestSpaceSession({
				serverUrl: worker.serverUrl,
				spaceName,
				session: {
					sessionId,
					environmentId: TEST_USER_ID,
					spaceName,
					title: "Runtime E2E Session",
					agent: "claude-acp",
					cwd: TEST_CWD,
				},
			});
			if (!createSessionResult.ok) {
				throw new Error(
					`createSession failed: ${JSON.stringify(createSessionResult, null, 2)}\ncli stdout:\n${cli.output.stdout}\ncli stderr:\n${cli.output.stderr}\nworker stdout:\n${worker.output.stdout}\nworker stderr:\n${worker.output.stderr}`
				);
			}
			expect(createSessionResult).toMatchObject({
				ok: true,
				value: {
					session: {
						id: sessionId,
						environmentId: TEST_USER_ID,
						streamKey: `session:${sessionId}`,
						syncStatus: "live",
					},
				},
			});

			await promptTestSpaceSession({
				serverUrl: worker.serverUrl,
				spaceName,
				sessionId,
				body: {
					prompt: [
						{
							type: "text",
							text: "Reply with a short greeting.",
						},
					],
				},
			});

			const events = await waitForSpaceSessionEvents({
				serverUrl: worker.serverUrl,
				spaceName,
				sessionId,
				timeoutMs: 180_000,
				predicate: (candidateEvents) => {
					const eventTypes = new Set(
						candidateEvents.map((event) => event.eventType)
					);
					return eventTypes.has("status") && eventTypes.has("text_delta");
				},
			});

			expect(events.some((event) => event.eventType === "status")).toBe(true);
			expect(events.some((event) => event.eventType === "text_delta")).toBe(
				true
			);
			expect(
				events.some((event) => {
					if (event.eventType !== "text_delta") {
						return false;
					}
					const payload = event.payload as {
						content?: {
							text?: string;
							type?: string;
						};
					};
					return (
						payload.content?.type === "text" &&
						typeof payload.content.text === "string" &&
						payload.content.text.length > 0
					);
				})
			).toBe(true);

			const session = await getSpaceSession({
				serverUrl: worker.serverUrl,
				spaceName,
				sessionId,
			});
			expect(session).toMatchObject({
				id: sessionId,
				environmentId: TEST_USER_ID,
				syncStatus: "live",
			});
			expect(session?.lastAppliedOffset).not.toBe("-1");
			expect(session?.lastEventAt).not.toBeNull();
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
	}, 300_000);
});
