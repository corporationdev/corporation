import { previewDriver } from "./preview-driver";
import { sessionDriver } from "./session-driver";
import { terminalDriver } from "./terminal-driver";

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
