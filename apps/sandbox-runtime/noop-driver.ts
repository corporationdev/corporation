import type { AgentDriver } from "./runtime-types";

export const noopDriver: AgentDriver = {
	async updateSessionConfig() {
		await Promise.resolve();
	},
	async run(input, emit) {
		const partId = crypto.randomUUID();
		emit({
			type: "message.part.updated",
			part: {
				id: partId,
				sessionId: input.sessionId,
				messageId: input.assistantMessageId,
				type: "text",
				text: "noop driver ran",
			},
		});
		emit({
			type: "message.part.delta",
			sessionId: input.sessionId,
			messageId: input.assistantMessageId,
			partId,
			field: "text",
			delta: "noop driver ran",
		});
		await Promise.resolve();
		return {
			stopReason: "end_turn",
		};
	},
};
