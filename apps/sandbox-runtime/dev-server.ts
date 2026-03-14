/* global Bun */

const PORT = Number(process.env.PORT) || 8787;

const _server = Bun.serve({
	port: PORT,
	fetch(req, server) {
		if (server.upgrade(req)) {
			return undefined;
		}
		return new Response("WebSocket server running", { status: 200 });
	},
	websocket: {
		open(_ws) {
			console.log("[server] client connected");
		},
		message(ws, message) {
			const text =
				typeof message === "string"
					? message
					: new TextDecoder().decode(message);
			console.log("[server] received:", text);

			try {
				const parsed = JSON.parse(text) as {
					type: string;
					requestId?: string;
				};

				// Echo back stream frames to the console
				if (parsed.type === "stream_items") {
					console.log("[server] stream items:", text);
					return;
				}

				// For responses, just log them
				if (parsed.type === "response") {
					console.log("[server] response:", text);
					return;
				}

				// Forward commands to the runtime (send them to the connected client)
				ws.send(text);
			} catch {
				console.log("[server] non-JSON message:", text);
			}
		},
		close() {
			console.log("[server] client disconnected");
		},
	},
});

console.log(`Dev WebSocket server listening on ws://localhost:${PORT}`);
