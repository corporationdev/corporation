import m0000 from "./0000_slimy_power_man.sql";
import m0001 from "./0001_sudden_space_metadata.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
	},
};
