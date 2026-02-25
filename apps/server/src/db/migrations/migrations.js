import m0000 from "./0000_glorious_darwin.sql";
import m0001 from "./0001_careful_harrier.sql";
import m0002 from "./0002_sturdy_falcon.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
	},
};
