import { appendCommitment } from "./commitments.js";

// Appends one commitment revision: npx tsx packages/intelligence/src/commit-run.ts --reason "<why>".
const root = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const i = process.argv.indexOf("--reason");
const reason = i >= 0 ? process.argv[i + 1] ?? "" : "";
const rev = appendCommitment(root, reason);
console.log(`intelligence commitment revision ${rev.revision} ${rev.hash.slice(0, 12)}`);
