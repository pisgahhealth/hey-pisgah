import { resolve } from "node:path";
import { listStreams, openStream, SEALED_AREAS } from "./index.js";

// Seals the plaintext words of every journal in the sealed areas of one store, with the serve stopped: `npx tsx packages/store/src/seal.run.ts <store root>`.
const root = resolve(process.argv[2] ?? ".hey-pisgah/emr-store");
let total = 0;
for (const area of SEALED_AREAS) {
  for (const id of listStreams(root, area)) {
    const s = openStream(root, id, { writer: true, allowPlain: true });
    try {
      const { lines } = s.sealPlain();
      total += lines;
      if (lines) process.stdout.write(`${id}: sealed ${lines} lines\n`);
    } finally {
      s.close();
    }
  }
}
process.stdout.write(`sealed ${total} lines under ${root}\n`);
