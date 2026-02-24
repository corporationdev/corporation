const journal = {
	entries: [
		{
			idx: 0,
			when: 1_771_905_713_648,
			tag: "0000_glorious_darwin",
			breakpoints: true,
		},
	],
};

const migrations = {
	m0000: `CREATE TABLE \`tabs\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`type\` text NOT NULL,
	\`title\` text NOT NULL,
	\`session_id\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	\`archived_at\` integer
);
--> statement-breakpoint
CREATE TABLE \`terminals\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tab_id\` text NOT NULL,
	\`pty_session_id\` text,
	\`cols\` integer NOT NULL,
	\`rows\` integer NOT NULL,
	\`scrollback_blob\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	FOREIGN KEY (\`tab_id\`) REFERENCES \`tabs\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`terminals_tab_id_unique\` ON \`terminals\` (\`tab_id\`);`,
};

export default {
	journal,
	migrations,
};
