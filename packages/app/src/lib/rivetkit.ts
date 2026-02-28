import { env } from "@corporation/env/web";
import type { registry } from "@corporation/server/registry";
import { createRivetKit } from "@rivetkit/react";
import { toAbsoluteUrl } from "./url";

export const { useActor } = createRivetKit<typeof registry>({
	endpoint: toAbsoluteUrl(`${env.VITE_SERVER_URL}/rivet`),
	disableMetadataLookup: true,
	devtools: false,
});

export type SpaceActor = ReturnType<typeof useActor<"space">>;
