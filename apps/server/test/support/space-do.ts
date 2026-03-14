import type {
	CreateSessionInput,
	CreateSessionResult,
	SpaceSessionRow,
} from "@corporation/contracts/browser-space";
import type { RuntimeEventRow } from "../../src/space-do/object";

export function buildCreateSpaceSessionUrl(input: {
	serverUrl: string;
	spaceName: string;
}): string {
	return new URL(
		`/api/test/space-do/${encodeURIComponent(input.spaceName)}/sessions`,
		input.serverUrl
	).toString();
}

export function buildPromptSpaceSessionUrl(input: {
	serverUrl: string;
	spaceName: string;
	sessionId: string;
}): string {
	return new URL(
		`/api/test/space-do/${encodeURIComponent(input.spaceName)}/sessions/${encodeURIComponent(input.sessionId)}/prompt`,
		input.serverUrl
	).toString();
}

export function buildGetSpaceSessionUrl(input: {
	serverUrl: string;
	spaceName: string;
	sessionId: string;
}): string {
	return new URL(
		`/api/test/space-do/${encodeURIComponent(input.spaceName)}/sessions/${encodeURIComponent(input.sessionId)}`,
		input.serverUrl
	).toString();
}

export function buildGetSpaceSessionEventsUrl(input: {
	serverUrl: string;
	spaceName: string;
	sessionId: string;
}): string {
	return new URL(
		`/api/test/space-do/${encodeURIComponent(input.spaceName)}/sessions/${encodeURIComponent(input.sessionId)}/events`,
		input.serverUrl
	).toString();
}

export async function createTestSpaceSession(input: {
	serverUrl: string;
	spaceName: string;
	session: CreateSessionInput;
}): Promise<CreateSessionResult> {
	const response = await fetch(
		buildCreateSpaceSessionUrl({
			serverUrl: input.serverUrl,
			spaceName: input.spaceName,
		}),
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(input.session),
		}
	);
	if (!response.ok) {
		throw new Error(
			`Failed to create space session (${response.status}): ${await response.text()}`
		);
	}
	return (await response.json()) as CreateSessionResult;
}

export async function promptTestSpaceSession(input: {
	serverUrl: string;
	spaceName: string;
	sessionId: string;
	body: {
		prompt: Array<{
			type: "text";
			text: string;
		}>;
		model?: string;
		mode?: string;
		configOptions?: Record<string, string>;
	};
}): Promise<null> {
	const response = await fetch(
		buildPromptSpaceSessionUrl({
			serverUrl: input.serverUrl,
			spaceName: input.spaceName,
			sessionId: input.sessionId,
		}),
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(input.body),
		}
	);
	if (!response.ok) {
		throw new Error(
			`Failed to prompt space session (${response.status}): ${await response.text()}`
		);
	}
	return (await response.json()) as null;
}

export async function getSpaceSession(input: {
	serverUrl: string;
	spaceName: string;
	sessionId: string;
}): Promise<SpaceSessionRow | null> {
	const response = await fetch(
		buildGetSpaceSessionUrl({
			serverUrl: input.serverUrl,
			spaceName: input.spaceName,
			sessionId: input.sessionId,
		})
	);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch space session (${response.status}): ${await response.text()}`
		);
	}
	return (await response.json()) as SpaceSessionRow | null;
}

export async function getSpaceSessionEvents(input: {
	serverUrl: string;
	spaceName: string;
	sessionId: string;
}): Promise<RuntimeEventRow[]> {
	const response = await fetch(
		buildGetSpaceSessionEventsUrl({
			serverUrl: input.serverUrl,
			spaceName: input.spaceName,
			sessionId: input.sessionId,
		})
	);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch space session events (${response.status}): ${await response.text()}`
		);
	}
	return (await response.json()) as RuntimeEventRow[];
}

export async function waitForSpaceSessionEvents(input: {
	serverUrl: string;
	spaceName: string;
	sessionId: string;
	predicate: (events: RuntimeEventRow[]) => boolean;
	timeoutMs?: number;
	pollIntervalMs?: number;
}): Promise<RuntimeEventRow[]> {
	const timeoutMs = input.timeoutMs ?? 120_000;
	const pollIntervalMs = input.pollIntervalMs ?? 500;
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const events = await getSpaceSessionEvents({
			serverUrl: input.serverUrl,
			spaceName: input.spaceName,
			sessionId: input.sessionId,
		});
		if (input.predicate(events)) {
			return events;
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error(
		`Timed out waiting for space session events for ${input.spaceName}/${input.sessionId}`
	);
}
