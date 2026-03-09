import { useEffect } from "react";
import type { SpaceActor } from "@/lib/rivetkit";

const KEEP_ALIVE_INTERVAL_MS = 300_000;

export function useKeepAliveSandbox(actor: SpaceActor, enabled: boolean) {
	useEffect(() => {
		if (!enabled || actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		let cancelled = false;

		const ping = async () => {
			try {
				await actor.connection?.keepAliveSandbox();
			} catch (error) {
				if (!cancelled) {
					console.error("Failed to keep sandbox alive", error);
				}
			}
		};

		ping();
		const intervalId = window.setInterval(() => {
			ping();
		}, KEEP_ALIVE_INTERVAL_MS);

		return () => {
			cancelled = true;
			window.clearInterval(intervalId);
		};
	}, [actor.connStatus, actor.connection, enabled]);
}
