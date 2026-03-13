import { DurableObject } from "cloudflare:workers";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import bundledMigrations from "./db/migrations";
import { schema } from "./db/schema";

export type {
	RuntimeEventRow,
	SpaceSessionRow as SessionRow,
} from "./db/schema";

export class SpaceDurableObject extends DurableObject<Env> {
	private readonly ready: Promise<void>;
	private db!: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ready = this.initialize();
		ctx.blockConcurrencyWhile(async () => {
			await this.ready;
		});
	}

	private async initialize(): Promise<void> {
		this.db = drizzle(this.ctx.storage, { schema });
		await migrate(this.db, bundledMigrations);
	}

	protected async getDb(): Promise<DrizzleSqliteDODatabase<typeof schema>> {
		await this.ready;
		return this.db;
	}

	async fetch(_request: Request): Promise<Response> {
		await this.ready;
		return new Response("Not found", { status: 404 });
	}
}
