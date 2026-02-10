import {
	useQueryClient,
	useQuery as useTanstackQuery,
} from "@tanstack/react-query";
import { useQuery as useConvexQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useEffect } from "react";

type CachedConvexQueryOptions<Query extends FunctionReference<"query">> = {
	query: Query;
	args: Query["_args"];
	cacheKey: string;
	readCache: () => Promise<Query["_returnType"]>;
	writeCache: (remoteData: Query["_returnType"]) => Promise<void>;
};

type CachedConvexQueryResult<Query extends FunctionReference<"query">> =
	| {
			data: undefined;
			isLoading: true;
	  }
	| {
			data: Query["_returnType"];
			isLoading: false;
	  };

const memoryCache = new Map<string, unknown>();

function getHotCache<Query extends FunctionReference<"query">>(
	cacheKey: string
): Query["_returnType"] | undefined {
	return memoryCache.get(cacheKey) as Query["_returnType"] | undefined;
}

function setHotCache<Query extends FunctionReference<"query">>(
	cacheKey: string,
	value: Query["_returnType"]
): void {
	memoryCache.set(cacheKey, value);
}

export function useCachedConvexQuery<Query extends FunctionReference<"query">>({
	query,
	args,
	cacheKey,
	readCache,
	writeCache,
}: CachedConvexQueryOptions<Query>): CachedConvexQueryResult<Query> {
	const queryClient = useQueryClient();
	const remoteData = useConvexQuery(query, args);
	const initialFromMemory = getHotCache<Query>(cacheKey);

	const localCacheQuery = useTanstackQuery({
		queryKey: ["convex-cache", cacheKey] as const,
		queryFn: async () => {
			const cachedData = await readCache();
			setHotCache<Query>(cacheKey, cachedData);
			return cachedData;
		},
		enabled: initialFromMemory === undefined,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const data = remoteData ?? localCacheQuery.data ?? initialFromMemory;

	useEffect(() => {
		if (remoteData === undefined) {
			return;
		}

		let cancelled = false;

		const syncRemoteData = async () => {
			try {
				await writeCache(remoteData);
			} finally {
				if (!cancelled) {
					setHotCache<Query>(cacheKey, remoteData);
					queryClient.setQueryData(["convex-cache", cacheKey], remoteData);
				}
			}
		};

		syncRemoteData().catch(() => {
			// Keep current UI state if remote sync fails unexpectedly.
		});

		return () => {
			cancelled = true;
		};
	}, [cacheKey, queryClient, remoteData, writeCache]);

	if (data === undefined) {
		return {
			data: undefined,
			isLoading: true,
		};
	}

	return {
		data,
		isLoading: false,
	};
}
