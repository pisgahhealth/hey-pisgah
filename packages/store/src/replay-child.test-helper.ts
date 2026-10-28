import { openStream, projectionHash, StoreError } from "./index.js";

// Child process for the fresh-process tests: prints a projection hash, or the error code a writer open gets.
const [root, streamId, mode] = process.argv.slice(2) as [string, string, string];
try {
  const s = openStream(root, streamId, { writer: mode === "writer" });
  process.stdout.write(projectionHash(s.records()));
  s.close();
} catch (e) {
  process.stdout.write(e instanceof StoreError ? e.code : "error");
}
