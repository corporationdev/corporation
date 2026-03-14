export async function waitForWebSocketReady(input: {
	timeoutMs?: number;
	url: string;
}): Promise<void> {
	const timeoutMs = input.timeoutMs ?? 10_000;
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		const opened = await new Promise<boolean>((resolve) => {
			const socket = new WebSocket(input.url);
			let settled = false;

			const finish = (value: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(value);
			};

			socket.addEventListener("open", () => {
				socket.close();
				finish(true);
			});
			socket.addEventListener("error", () => {
				finish(false);
			});
			socket.addEventListener("close", () => {
				finish(false);
			});
		});

		if (opened) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(`Timed out waiting for websocket readiness at ${input.url}`);
}
