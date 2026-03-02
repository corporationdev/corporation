import { ConvexError } from "convex/values";

export const MIN_DEV_PORT = 1;
export const MAX_DEV_PORT = 65_535;

export function assertValidDevPort(devPort: number | undefined): void {
	if (devPort === undefined) {
		return;
	}

	if (
		!Number.isInteger(devPort) ||
		devPort < MIN_DEV_PORT ||
		devPort > MAX_DEV_PORT
	) {
		throw new ConvexError(
			`devPort must be an integer between ${MIN_DEV_PORT} and ${MAX_DEV_PORT}`
		);
	}
}
