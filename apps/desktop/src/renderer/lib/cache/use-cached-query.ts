import { useEffect, useRef, useState } from "react";

type CachedQueryOptions<TLocal, TRemote> = {
	readCache: () => TLocal;
	writeCache: (data: TRemote) => void;
	remoteData: TRemote | undefined;
};

type CachedQueryResult<TLocal> = {
	data: TLocal;
	isFromCache: boolean;
	isSyncing: boolean;
};

export function useCachedQuery<TLocal, TRemote>({
	readCache,
	writeCache,
	remoteData,
}: CachedQueryOptions<TLocal, TRemote>): CachedQueryResult<TLocal> {
	const readCacheRef = useRef(readCache);
	readCacheRef.current = readCache;

	const [data, setData] = useState<TLocal>(() => readCacheRef.current());
	const [isFromCache, setIsFromCache] = useState(true);

	useEffect(() => {
		if (remoteData === undefined) {
			return;
		}

		writeCache(remoteData);
		setData(readCacheRef.current());
		setIsFromCache(false);
	}, [remoteData, writeCache]);

	return {
		data,
		isFromCache,
		isSyncing: remoteData === undefined,
	};
}
