# store

Append-only JSONL streams. Every durable record in Hey Pisgah is one line here.

| Rule | How |
| --- | --- |
| One file per stream | `<root>/<stream_id>.jsonl`, for example `ledger/run-ab12cd34.jsonl` |
| One writer | `<stream_id>.lock` is created with O_EXCL and holds pid, process start time, host and a token |
| Second writer | refused with `store_locked` |
| Takeover | only on the same host, when the pid is gone or now belongs to a process with another start time; recorded as `writer.takeover` |
| Token check | the writer re-reads the lock before every append and stops with `store_lost_lock` if the token changed |
| Chain | each line is a sealed envelope; `prev_hash` links it to the line before |
| Durability | one line per append, then `fs.fsyncSync` (see below) |
| Crash tail | readers ignore an unterminated last line; the writer truncates it on open and appends `store.recovered` |
| Earlier damage | a writer moves the file to `.quarantine` and throws `store_quarantined`; a reader throws `store_corrupt` and changes nothing |
| Run copies | `copyForRun` copies validated lines to `runs/<run_id>/` once, by temp folder and rename, inside an allowlist of roots |

## fsync on macOS

`fs.fsyncSync` calls libuv. On macOS libuv issues `fcntl(F_FULLFSYNC)`, falls back to `F_BARRIERFSYNC`, then to plain `fsync`.
So the store gets a full flush to the drive with no native code.
Source: libuv `src/unix/fs.c`, function `uv__fs_fsync`, tag v1.52.1 (the libuv in Node 20.19.5), checked 28 Oct 2026.

## Projections

`projectionHash` hashes the determinism view of the domain records.
It leaves out `wall_at`, the chain fields and the store's own records, so recovery and takeover do not change it.
