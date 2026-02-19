import { contextBridge, ipcRenderer } from "electron";
import type { LocalCacheApi } from "../shared/ipc-api";

const localCache: LocalCacheApi = {
	events: {
		getForSession: (sessionId) =>
			ipcRenderer.invoke("cache:events:getForSession", sessionId),
		appendMany: (events) =>
			ipcRenderer.invoke("cache:events:appendMany", events),
	},
};

contextBridge.exposeInMainWorld("localCache", localCache);
