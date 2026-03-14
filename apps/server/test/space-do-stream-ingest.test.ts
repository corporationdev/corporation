import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sessions } from "../src/space-do/db/schema";
import type { SpaceDurableObject } from "../src/space-do/object";

async function seedSession(input: {
	spaceName: string;
	sessionId: string;
	clientId?: string;
}) {
	const spaceStub = env.SPACE_DO.get(
		env.SPACE_DO.idFromName(input.spaceName)
	) as DurableObjectStub<SpaceDurableObject>;

	await runInDurableObject(spaceStub, async (instance) => {
		const space = instance as unknown as SpaceDurableObject & {
			getDb(): Promise<Awaited<ReturnType<SpaceDurableObject["getDb"]>>>;
		};
		const db = await space.getDb();
		const now = Date.now();
		await db.insert(sessions).values({
			id: input.sessionId,
			clientId: input.clientId ?? "environment-1",
			streamKey: `session:${input.sessionId}`,
			title: "Test Session",
			agent: "claude",
			cwd: "/workspace",
			model: null,
			mode: null,
			configOptions: null,
			lastAppliedOffset: "-1",
			lastEventAt: null,
			lastSyncError: null,
			createdAt: now,
			updatedAt: now,
			archivedAt: null,
		});
	});

	return spaceStub;
}

describe("SpaceDurableObject stream ingest", () => {
	it("persists delivered runtime events and advances the committed offset", async () => {
		const spaceStub = await seedSession({
			spaceName: "space-stream-ingest",
			sessionId: "session-1",
		});

		await expect(
			spaceStub.receiveEnvironmentStreamItems({
				stream: "session:session-1",
				requesterId: "session-1",
				items: [
					{
						offset: "1",
						eventId: "event-1",
						createdAt: 100,
						event: {
							kind: "status",
							sessionId: "session-1",
							status: "running",
							commandId: "command-1",
						},
					},
					{
						offset: "2",
						eventId: "event-2",
						createdAt: 101,
						event: {
							kind: "status",
							sessionId: "session-1",
							status: "idle",
						},
					},
				],
				nextOffset: "2",
				upToDate: true,
				streamClosed: false,
			})
		).resolves.toEqual({
			ok: true,
			value: {
				committedOffset: "2",
			},
		});

		const persisted = await runInDurableObject(spaceStub, async (instance) => {
			const space = instance as unknown as SpaceDurableObject & {
				getDb(): Promise<Awaited<ReturnType<SpaceDurableObject["getDb"]>>>;
			};
			const db = await space.getDb();
			return {
				session: await db.query.sessions.findFirst({
					where: (table, { eq }) => eq(table.id, "session-1"),
				}),
				events: await db.query.runtimeEvents.findMany({
					where: (table, { eq }) => eq(table.sessionId, "session-1"),
					orderBy: (table, { asc }) => [asc(table.offsetSeq)],
				}),
			};
		});

		expect(persisted.session).toMatchObject({
			id: "session-1",
			lastAppliedOffset: "2",
			lastEventAt: 101,
			lastSyncError: null,
		});
		expect(persisted.events).toEqual([
			expect.objectContaining({
				eventId: "event-1",
				streamKey: "session:session-1",
				sessionId: "session-1",
				offset: "1",
				offsetSeq: 1,
				commandId: "command-1",
				eventType: "status",
				createdAt: 100,
				payload: {
					kind: "status",
					sessionId: "session-1",
					status: "running",
					commandId: "command-1",
				},
			}),
			expect.objectContaining({
				eventId: "event-2",
				streamKey: "session:session-1",
				sessionId: "session-1",
				offset: "2",
				offsetSeq: 2,
				commandId: null,
				eventType: "status",
				createdAt: 101,
				payload: {
					kind: "status",
					sessionId: "session-1",
					status: "idle",
				},
			}),
		]);
	});

	it("dedupes replayed events and keeps the highest committed offset", async () => {
		const spaceStub = await seedSession({
			spaceName: "space-stream-replay",
			sessionId: "session-2",
		});

		await spaceStub.receiveEnvironmentStreamItems({
			stream: "session:session-2",
			requesterId: "session-2",
			items: [
				{
					offset: "1",
					eventId: "event-1",
					createdAt: 100,
					event: { kind: "status", sessionId: "session-2", status: "running" },
				},
				{
					offset: "2",
					eventId: "event-2",
					createdAt: 101,
					event: { kind: "status", sessionId: "session-2", status: "idle" },
				},
			],
			nextOffset: "2",
			upToDate: true,
			streamClosed: false,
		});

		await expect(
			spaceStub.receiveEnvironmentStreamItems({
				stream: "session:session-2",
				requesterId: "session-2",
				items: [
					{
						offset: "1",
						eventId: "event-1",
						createdAt: 100,
						event: {
							kind: "status",
							sessionId: "session-2",
							status: "running",
						},
					},
					{
						offset: "2",
						eventId: "event-2",
						createdAt: 101,
						event: { kind: "status", sessionId: "session-2", status: "idle" },
					},
				],
				nextOffset: "2",
				upToDate: true,
				streamClosed: false,
			})
		).resolves.toEqual({
			ok: true,
			value: {
				committedOffset: "2",
			},
		});

		const persisted = await runInDurableObject(spaceStub, async (instance) => {
			const space = instance as unknown as SpaceDurableObject & {
				getDb(): Promise<Awaited<ReturnType<SpaceDurableObject["getDb"]>>>;
			};
			const db = await space.getDb();
			return {
				session: await db.query.sessions.findFirst({
					where: (table, { eq }) => eq(table.id, "session-2"),
				}),
				eventCount: (
					await db.query.runtimeEvents.findMany({
						where: (table, { eq }) => eq(table.sessionId, "session-2"),
					})
				).length,
			};
		});

		expect(persisted.session).toMatchObject({
			id: "session-2",
			lastAppliedOffset: "2",
			lastEventAt: 101,
		});
		expect(persisted.eventCount).toBe(2);
	});

	it("wakes live stream readers as soon as new events are ingested", async () => {
		const spaceStub = await seedSession({
			spaceName: "space-stream-live",
			sessionId: "session-3",
		});

		const liveReadPromise = spaceStub.readSessionStream(
			"session-3",
			-1,
			200,
			true,
			1000
		);

		await new Promise((resolve) => setTimeout(resolve, 50));

		await spaceStub.receiveEnvironmentStreamItems({
			stream: "session:session-3",
			requesterId: "session-3",
			items: [
				{
					offset: "1",
					eventId: "event-live-1",
					createdAt: 100,
					event: {
						kind: "status",
						sessionId: "session-3",
						status: "running",
					},
				},
			],
			nextOffset: "1",
			upToDate: true,
			streamClosed: false,
		});

		const timeoutToken = Symbol("timeout");
		const result = await Promise.race([
			liveReadPromise,
			new Promise<symbol>((resolve) => {
				setTimeout(() => resolve(timeoutToken), 150);
			}),
		]);

		expect(result).not.toBe(timeoutToken);
		expect(result).toMatchObject({
			frames: [
				expect.objectContaining({
					kind: "event",
					offset: 1,
					eventId: "event-live-1",
				}),
			],
			nextOffset: 1,
			upToDate: true,
			streamClosed: false,
		});
	});
});
