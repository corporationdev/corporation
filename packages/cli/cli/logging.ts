import { formatWithOptions } from "node:util";
import pino from "pino";

export type Logger = pino.Logger;

const levelNames: Record<number, string> = {
	10: "trace",
	20: "debug",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal",
};

function formatConsoleArgs(args: unknown[]): string {
	return formatWithOptions(
		{
			breakLength: Number.POSITIVE_INFINITY,
			colors: false,
			compact: true,
			depth: 8,
		},
		...args
	);
}

export function createDaemonLogger(logPath: string): Logger {
	return pino(
		{
			level: process.env.TENDRIL_LOG_LEVEL?.trim() || "info",
		},
		pino.destination({
			dest: logPath,
			mkdir: true,
			sync: false,
		})
	).child({ name: "tendril-daemon" });
}

export function installConsoleLogger(logger: Logger): () => void {
	const original = {
		debug: console.debug.bind(console),
		error: console.error.bind(console),
		info: console.info.bind(console),
		log: console.log.bind(console),
		warn: console.warn.bind(console),
	};

	console.debug = (...args: unknown[]) => {
		logger.debug({ console: true }, formatConsoleArgs(args));
	};
	console.log = (...args: unknown[]) => {
		logger.info({ console: true }, formatConsoleArgs(args));
	};
	console.info = (...args: unknown[]) => {
		logger.info({ console: true }, formatConsoleArgs(args));
	};
	console.warn = (...args: unknown[]) => {
		logger.warn({ console: true }, formatConsoleArgs(args));
	};
	console.error = (...args: unknown[]) => {
		logger.error({ console: true }, formatConsoleArgs(args));
	};

	return () => {
		console.debug = original.debug;
		console.error = original.error;
		console.info = original.info;
		console.log = original.log;
		console.warn = original.warn;
	};
}

export function formatLogLine(line: string): string {
	const trimmed = line.trim();
	if (!trimmed) {
		return "";
	}

	try {
		const parsed = JSON.parse(trimmed) as {
			level?: number;
			msg?: string;
			name?: string;
			time?: string | number;
		} & Record<string, unknown>;
		const level = levelNames[parsed.level ?? 30] ?? "info";
		const timestamp =
			typeof parsed.time === "string"
				? parsed.time
				: typeof parsed.time === "number"
					? new Date(parsed.time).toISOString()
					: new Date().toISOString();
		const name = typeof parsed.name === "string" ? parsed.name : "tendril";
		const message = typeof parsed.msg === "string" ? parsed.msg : trimmed;
		const {
			level: _level,
			msg: _msg,
			name: _name,
			time: _time,
			...extras
		} = parsed;
		const extraText =
			Object.keys(extras).length > 0 ? ` ${JSON.stringify(extras)}` : "";
		return `${timestamp} [${level}] ${name}: ${message}${extraText}`;
	} catch {
		return trimmed;
	}
}
