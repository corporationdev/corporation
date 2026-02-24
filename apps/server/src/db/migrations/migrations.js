const journal = {
	entries: [
		{
			idx: 0,
			when: 1_771_826_608_292,
			tag: "0000_chief_monster_badoon",
			breakpoints: true,
		},
		{
			idx: 1,
			when: 1_771_925_200_000,
			tag: "0001_raw_acp_session_persistence",
			breakpoints: true,
		},
	],
};

const migrations = {
	m0000: `CREATE TABLE \`session_events\` (
	\`session_id\` text NOT NULL,
	\`sequence\` integer NOT NULL,
	\`event_json\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	PRIMARY KEY(\`session_id\`, \`sequence\`),
	FOREIGN KEY (\`session_id\`) REFERENCES \`sessions\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`sessions\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tab_id\` text NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	FOREIGN KEY (\`tab_id\`) REFERENCES \`tabs\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`sessions_tab_id_unique\` ON \`sessions\` (\`tab_id\`);--> statement-breakpoint
CREATE TABLE \`tabs\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`type\` text NOT NULL,
	\`title\` text NOT NULL,
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
	m0001: `ALTER TABLE \`sessions\` ADD \`agent\` text DEFAULT 'opencode' NOT NULL;
--> statement-breakpoint
ALTER TABLE \`sessions\` ADD \`agent_session_id\` text;
--> statement-breakpoint
ALTER TABLE \`sessions\` ADD \`last_connection_id\` text;
--> statement-breakpoint
ALTER TABLE \`sessions\` ADD \`session_init_json\` text;
--> statement-breakpoint
ALTER TABLE \`sessions\` ADD \`destroyed_at\` integer;`,
};

export default {
	journal,
	migrations,
};
