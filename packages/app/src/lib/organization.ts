import { authClient } from "@/lib/auth-client";

const ORGANIZATION_SLUG_MAX_LENGTH = 48;
const ORGANIZATION_INITIALS_SPLIT_REGEX = /\s+/;

export function getAuthErrorMessage(
	error: {
		message?: string;
		statusText?: string;
	} | null
) {
	return error?.message || error?.statusText || "Request failed";
}

export function slugifyOrganizationName(name: string) {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, ORGANIZATION_SLUG_MAX_LENGTH) || "workspace"
	);
}

export function getOrganizationInitials(name: string) {
	return name
		.split(ORGANIZATION_INITIALS_SPLIT_REGEX)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
}

function withSlugSuffix(base: string, index: number) {
	if (index === 0) {
		return base;
	}

	const suffix = `-${index + 1}`;
	return `${base.slice(0, Math.max(1, ORGANIZATION_SLUG_MAX_LENGTH - suffix.length))}${suffix}`;
}

export async function reserveOrganizationSlug(name: string) {
	const base = slugifyOrganizationName(name);

	for (let index = 0; index < 20; index += 1) {
		const slug = withSlugSuffix(base, index);

		try {
			await authClient.organization.checkSlug({ slug });
			return slug;
		} catch (error) {
			const message = error instanceof Error ? error.message.toLowerCase() : "";
			if (!message.includes("slug")) {
				throw error;
			}
		}
	}

	throw new Error("Unable to reserve an organization slug");
}

export async function createOrganizationFromName(name: string) {
	const trimmedName = name.trim();
	if (!trimmedName) {
		throw new Error("Organization name is required");
	}

	const slug = await reserveOrganizationSlug(trimmedName);
	const result = await authClient.organization.create({
		name: trimmedName,
		slug,
	});

	if (!(result.data && !result.error)) {
		throw new Error(getAuthErrorMessage(result.error));
	}

	return result.data;
}
