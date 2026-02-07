import pino from "pino";

export type Logger = pino.Logger;

export const createLogger = (name: string): pino.Logger => {
	return pino({
		level: "debug",
		transport: {
			target: "pino-pretty",
		},
	}).child({ name });
};
