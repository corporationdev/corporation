declare const _default: {
	journal: {
		version: string;
		dialect: string;
		entries: Array<{
			idx: number;
			version: string;
			when: number;
			tag: string;
			breakpoints: boolean;
		}>;
	};
	migrations: Record<string, string>;
};

export default _default;
