import { sessionDriver } from "./session-driver";
import { terminalDriver } from "./terminal-driver";

export const driverRegistry = {
	session: sessionDriver,
	terminal: terminalDriver,
} as const;

export const lifecycleDrivers = [
	driverRegistry.session,
	driverRegistry.terminal,
] as const;
