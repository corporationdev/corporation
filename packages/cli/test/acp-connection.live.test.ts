import { describe, expect, test } from "bun:test";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import { createSpawnedAcpConnectionFactory } from "../agent-runtime/acp-connection";

const LIVE_AGENT = process.env.ACP_LIVE_AGENT?.trim();

describe("ACP Connection Live", () => {
	if (LIVE_AGENT) {
		test("can initialize and create a real ACP session", async () => {
			const factory = createSpawnedAcpConnectionFactory();
			const connection = await factory.connect(LIVE_AGENT);

			try {
				await connection.request(AGENT_METHODS.initialize, {
					protocolVersion: 2,
					clientInfo: {
						name: "sandbox-runtime-live-test",
						version: "v1",
					},
				});

				const created = await connection.request(AGENT_METHODS.session_new, {
					cwd: process.cwd(),
					mcpServers: [],
				});

				expect(created.sessionId).toBeString();
			} finally {
				await connection.close?.();
			}
		});
	} else {
		// biome-ignore lint/suspicious/noSkippedTests: this integration test is opt-in via ACP_LIVE_AGENT
		test.skip("can initialize and create a real ACP session", () => undefined);
	}
});
