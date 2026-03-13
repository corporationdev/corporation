import { eq } from "drizzle-orm";
import type { EnvironmentStreamOffset } from "@corporation/contracts/environment-do";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import { environmentStreamSubscriptions } from "./db/schema";
import type {
	EnvironmentPersistedStreamSubscription,
	EnvironmentStreamSubscriptionState,
} from "./types";

type EnvironmentDatabase = ReturnType<typeof drizzle>;

export class EnvironmentSubscriptionStore {
	constructor(private readonly db: EnvironmentDatabase) {}

	async list(): Promise<
		Array<{
			stream: string;
			subscription: EnvironmentStreamSubscriptionState;
		}>
	> {
		const rows = await this.db
			.select()
			.from(environmentStreamSubscriptions);
		return rows.map((row) => ({
			stream: row.stream,
			subscription: {
				offset: row.lastPersistedOffset as EnvironmentStreamOffset,
				subscriber: {
					requesterId: row.requesterId,
					callback: {
						binding: row.callbackBinding as
							| "SPACE_DO"
							| "TEST_STREAM_CONSUMER_DO",
						name: row.callbackName,
					},
				},
			},
		}));
	}

	async upsert(input: EnvironmentPersistedStreamSubscription): Promise<void> {
		const now = Date.now();
		await this.db
			.insert(environmentStreamSubscriptions)
			.values({
				stream: input.stream,
				requesterId: input.subscriber.requesterId,
				callbackBinding: input.subscriber.callback.binding,
				callbackName: input.subscriber.callback.name,
				lastPersistedOffset: input.lastPersistedOffset,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: environmentStreamSubscriptions.stream,
				set: {
					requesterId: input.subscriber.requesterId,
					callbackBinding: input.subscriber.callback.binding,
					callbackName: input.subscriber.callback.name,
					lastPersistedOffset: input.lastPersistedOffset,
					updatedAt: now,
				},
			});
	}

	async delete(stream: string): Promise<void> {
		await this.db
			.delete(environmentStreamSubscriptions)
			.where(eq(environmentStreamSubscriptions.stream, stream));
	}

	async updatePersistedOffset(input: {
		stream: string;
		offset: EnvironmentStreamOffset;
	}): Promise<void> {
		await this.db
			.update(environmentStreamSubscriptions)
			.set({
				lastPersistedOffset: input.offset,
				updatedAt: Date.now(),
			})
			.where(eq(environmentStreamSubscriptions.stream, input.stream));
	}
}
