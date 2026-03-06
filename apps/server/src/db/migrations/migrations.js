import m0000 from "./0000_common_wiccan.sql";
import m0001 from "./0001_eminent_cerise.sql";
import m0002 from "./0002_remarkable_black_cat.sql";
import m0003 from "./0003_freezing_ozymandias.sql";
import journal from "./meta/_journal.json";

export default {
	journal,
	migrations: {
		m0000,
		m0001,
		m0002,
		m0003,
	},
};
