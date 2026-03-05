declare module "*.sql" {
	const content: string;
	export default content;
}

declare const bundledMigrations: {
	journal: {
		entries: Array<{
			idx: number;
			when: number;
			tag: string;
			breakpoints: boolean;
		}>;
	};
	migrations: Record<string, string>;
};

export default bundledMigrations;
