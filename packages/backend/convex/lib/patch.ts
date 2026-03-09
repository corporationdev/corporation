type PatchFieldKey<TPatch extends Record<string, unknown>> = Extract<
	keyof TPatch,
	string
>;

export function buildConvexPatch<
	TPatch extends Record<string, unknown>,
	TArgs extends Record<string, unknown>,
>(
	args: TArgs,
	options: {
		assign?: readonly PatchFieldKey<TPatch>[];
		clearable?: readonly PatchFieldKey<TPatch>[];
	}
): Partial<TPatch> {
	const patch: Partial<TPatch> = {};

	for (const key of options.assign ?? []) {
		const value = args[key];
		if (value !== undefined) {
			patch[key] = value as TPatch[typeof key];
		}
	}

	for (const key of options.clearable ?? []) {
		if (!(key in args)) {
			continue;
		}

		const value = args[key];
		patch[key] =
			value === null
				? (undefined as TPatch[typeof key])
				: (value as TPatch[typeof key]);
	}

	return patch;
}
