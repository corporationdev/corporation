import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SpaceDurableObject } from "../src/space-do/object";
import { sessions } from "../src/space-do/db/schema";

async function seedSession(input: {
	spaceName: string;
	sessionId: string;
	environmentId?: string;
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
			environmentId: input.environmentId ?? "environment-1",
			streamKey: `session:${input.sessionId}`,
			title: "Test Session",
			agent: "claude",
			cwd: "/workspace",
			model: null,
			mode: null,
			configOptions: null,
			syncStatus: "pending",
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
							type: "turn.started",
							turnId: "turn-1",
							commandId: "command-1",
						},
					},
					{
						offset: "2",
						eventId: "event-2",
						createdAt: 101,
						event: {
							type: "turn.completed",
							turnId: "turn-1",
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
			syncStatus: "live",
		});
		expect(persisted.events).toEqual([
			expect.objectContaining({
				eventId: "event-1",
				streamKey: "session:session-1",
				sessionId: "session-1",
				offset: "1",
				offsetSeq: 1,
				commandId: "command-1",
				turnId: "turn-1",
				eventType: "turn.started",
				createdAt: 100,
				payload: {
					type: "turn.started",
					turnId: "turn-1",
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
				turnId: "turn-1",
				eventType: "turn.completed",
				createdAt: 101,
				payload: {
					type: "turn.completed",
					turnId: "turn-1",
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
					event: { type: "turn.started", turnId: "turn-1" },
				},
				{
					offset: "2",
					eventId: "event-2",
					createdAt: 101,
					event: { type: "turn.completed", turnId: "turn-1" },
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
						event: { type: "turn.started", turnId: "turn-1" },
					},
					{
						offset: "2",
						eventId: "event-2",
						createdAt: 101,
						event: { type: "turn.completed", turnId: "turn-1" },
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
});
