import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";

export function requireProjectInActiveOrg(
	project: Doc<"projects"> | null,
	activeOrganizationId: string | null,
	resourceName: string,
	options?: { allowBase?: boolean }
): Doc<"projects"> {
	if (
		!(
			project &&
			project.organizationId === activeOrganizationId &&
			(options?.allowBase || project.kind === "standard")
		)
	) {
		throw new ConvexError(`${resourceName} not found`);
	}

	return project;
}
