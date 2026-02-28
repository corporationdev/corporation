import type { BuildRequest } from "@corporation/shared/api/environments";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import type { BuildStep } from "./db/schema";

export type EnvironmentDatabase = ReturnType<typeof drizzle>;

export type BuildConfig = BuildRequest;

export type BuildReporter = {
	setStep: (step: BuildStep) => void;
	appendLog: (chunk: string) => void;
};

export type EnvironmentVars = {
	db: EnvironmentDatabase;
};
