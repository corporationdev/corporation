import type { CacheAdapter } from "@corporation/app/cache-adapter";
import { contextBridge, ipcRenderer } from "electron";

const localCache: CacheAdapter = {
	events: {
		getForSession: (sessionId) =>
			ipcRenderer.invoke("cache:events:getForSession", sessionId),
		appendMany: (events) =>
			ipcRenderer.invoke("cache:events:appendMany", events),
	},
};

contextBridge.exposeInMainWorld("localCache", localCache);
