import fs from "node:fs";

const LOG_PATH = "/tmp/sandbox-runtime.log";
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

export function log(
	level: "info" | "warn" | "error",
	msg: string,
	data?: unknown
) {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		msg,
		...(data !== undefined ? { data } : {}),
	});
	logStream.write(`${line}\n`);
	if (level === "error") {
		console.error(`[sandbox-runtime] ${msg}`, data ?? "");
	}
}
