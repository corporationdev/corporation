import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	createHarness,
	eventually,
	startRealRuntimeProcess,
} from "./helpers/runtime-do-harness";

const SPACE_SLUG = "runtime-process-space";
const SANDBOX_ID = "sandbox-local-runtime";
const AGENT_ID = "claude-acp";

type Harness = Awaited<ReturnType<typeof createHarness>>;

describe("sandbox-runtime process integration (local worker)", () => {
	let harness: Harness;

	beforeAll(async () => {
		harness = await createHarness();
	});

	afterAll(async () => {
		await harness.cleanup();
	});

	test("the real sandbox-runtime process connects and answers probe requests", async () => {
		const browser = await harness.createBrowserClient(SPACE_SLUG);
		const runtime = await startRealRuntimeProcess({
			baseUrl: harness.baseUrl,
			spaceSlug: SPACE_SLUG,
			sandboxId: SANDBOX_ID,
			runtimeAuthSecret: harness.runtimeAuthSecret,
		});

		try {
			const result = await eventually(
				() => browser.client.getAgentProbeState(),
				(probe) =>
					probe.agents.some(
						(agent) =>
							agent.id === AGENT_ID &&
							agent.error !== "Sandbox runtime is unavailable"
					),
				"runtime process probe result"
			);

			const agent =
				result.agents.find((entry) => entry.id === AGENT_ID) ?? null;
			expect(agent).not.toBeNull();
			expect(agent?.error).not.toBe("Sandbox runtime is unavailable");
		} finally {
			browser.close();
			await runtime.stop();
		}
	});
});
