import { contextBridge, ipcRenderer } from "electron";

import type { LocalCacheApi } from "../shared/ipc-api";

const localCache: LocalCacheApi = {
	sessions: {
		getAll: () => ipcRenderer.sendSync("cache:sessions:getAll"),
		getById: (id) => ipcRenderer.sendSync("cache:sessions:getById", id),
		replaceAll: (sessions) => {
			ipcRenderer.invoke("cache:sessions:replaceAll", sessions);
		},
		upsert: (session) => {
			ipcRenderer.invoke("cache:sessions:upsert", session);
		},
	},
	events: {
		getForSession: (sessionId) =>
			ipcRenderer.sendSync("cache:events:getForSession", sessionId),
		appendMany: (events) => {
			ipcRenderer.invoke("cache:events:appendMany", events);
		},
		deleteForSession: (sessionId) => {
			ipcRenderer.invoke("cache:events:deleteForSession", sessionId);
		},
	},
};

contextBridge.exposeInMainWorld("localCache", localCache);
