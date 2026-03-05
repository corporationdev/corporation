import m0000 from "./0000_initial.sql";
import m0001 from "./0001_old_marvel_boy.sql";
import m0002 from "./0002_damp_venus.sql";
import m0003 from "./0003_session_run_state.sql";
import m0004 from "./0004_gifted_ultragirl.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
		m0003,
		m0004,
	},
};
