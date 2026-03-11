import { env } from "@corporation/env/web";
import type { registry } from "@corporation/server/registry";
import { createClient, createRivetKit } from "@rivetkit/react";
import { getAuthToken } from "./api-client";
import { toAbsoluteUrl } from "./url";

const rivetEndpoint = toAbsoluteUrl(`${env.VITE_CORPORATION_SERVER_URL}/rivet`);

export const { useActor } = createRivetKit<typeof registry>({
	endpoint: rivetEndpoint,
	disableMetadataLookup: true,
	devtools: false,
});

export type SpaceActor = ReturnType<typeof useActor>;

export function createRivetClient() {
	return createClient<typeof registry>({
		endpoint: rivetEndpoint,
		disableMetadataLookup: true,
		devtools: false,
	});
}

export async function getAuthedSpaceActorHandle(spaceSlug: string) {
	const authToken = await getAuthToken();
	return createRivetClient().space.get([spaceSlug], {
		params: { authToken },
	});
}
