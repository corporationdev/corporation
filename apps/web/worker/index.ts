export default {
	fetch(request: Request, env: Env): Response | Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api")) {
			return env.API.fetch(request);
		}

		return env.ASSETS.fetch(request);
	},
};
