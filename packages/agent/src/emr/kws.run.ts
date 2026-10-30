import { homedir } from "node:os";
import { join } from "node:path";
import { prepareKwsAssets } from "./kws.js";

// Prepares the strip's wake-phrase spotter files once, into HEY_PISGAH_KWS_DIR or ~/.hey-pisgah/kws.
const dir = process.env["HEY_PISGAH_KWS_DIR"] ?? join(homedir(), ".hey-pisgah", "kws");
const r = prepareKwsAssets(dir);
process.stdout.write(`kws assets in ${r.dir}: ${Object.entries(r.files).map(([n, f]) => `${n} ${f.bytes}`).join(", ")}\n`);
