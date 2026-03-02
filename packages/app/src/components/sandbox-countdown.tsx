import { TimerIcon } from "lucide-react";
import { type FC, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SpaceActor } from "@/lib/rivetkit";

export const SandboxCountdown: FC<{
	expiresAt?: number;
	actor: SpaceActor;
}> = ({ expiresAt, actor }) => {
	const [minutesLeft, setMinutesLeft] = useState<number | null>(() => {
		if (!expiresAt) {
			return null;
		}
		return Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
	});

	useEffect(() => {
		if (!expiresAt) {
			setMinutesLeft(null);
			return;
		}

		const update = () => {
			setMinutesLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000)));
		};
		update();

		const interval = setInterval(update, 60_000);
		return () => clearInterval(interval);
	}, [expiresAt]);

	if (minutesLeft === null || minutesLeft > 2) {
		return null;
	}

	return (
		<Button
			className="w-full justify-start gap-2"
			onClick={() => actor.connection?.resetTimeout()}
			size="sm"
			variant="outline"
		>
			<TimerIcon className="size-4" />
			{minutesLeft === 0 ? "Expiring" : `${minutesLeft} min left`} — Extend
		</Button>
	);
};
