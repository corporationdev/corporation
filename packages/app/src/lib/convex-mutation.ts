import {
	type UseMutationOptions,
	useMutation as useTanstackMutation,
} from "@tanstack/react-query";
import { useMutation as useConvexMutation } from "convex/react";
import type {
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
} from "convex/server";

export function useConvexTanstackMutation<
	Mutation extends FunctionReference<"mutation">,
>(
	mutation: Mutation,
	options?: Omit<
		UseMutationOptions<
			FunctionReturnType<Mutation>,
			Error,
			FunctionArgs<Mutation>
		>,
		"mutationFn"
	>
) {
	const convexMutation = useConvexMutation(mutation);
	return useTanstackMutation({
		mutationFn: (args: FunctionArgs<Mutation>) => convexMutation(args),
		...options,
	});
}
