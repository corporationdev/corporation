import { previewDriver } from "./preview";
import { sessionDriver } from "./session";
import { terminalDriver } from "./terminal";

export const driverRegistry = {
	session: sessionDriver,
	terminal: terminalDriver,
	preview: previewDriver,
} as const;

export const lifecycleDrivers = [
	driverRegistry.session,
	driverRegistry.terminal,
	driverRegistry.preview,
] as const;
