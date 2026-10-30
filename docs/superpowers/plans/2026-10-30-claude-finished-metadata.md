# Claude finished metadata repair

The audit session shows 22 active children, but its native sidecars mark 86 of 91 finished and leave five unfinished. Branchline previously derived completion only from transcript turns or parent notifications. Cancelled/interrupted workers can have an unfinished final transcript despite a terminal native marker.

Use explicit `finished: true` on attach and live metadata-only changes, including the existing polling fallback. Cache metadata by file signature; malformed or transiently missing files cannot undo a known completion. Missing flags remain unknown: quiet workers must not expire. Preserve final usage/model settings without replaying tools from completed history; a cleared marker plus a genuinely new turn can resume work.

Give freshly created transcripts a short discovery grace while their sidecar is written, using existing scans rather than another timer. Historical legacy transcripts without sidecars continue to work. Client replay must restore completed children and leave quiet running children registered.

Verification: reproduce 22 workers with 17 terminal sidecars through the actual watcher, bounded event replay and frontend state reducer; expect five active and all cost history retained. Cover metadata-only updates, late usage, malformed metadata, actual resumption and delayed sidecar discovery. Run root/extension suites and types, build in isolation, review, compare the real audit session with native metadata, then commit/push/restart under the user's standing authorization.

Preview startup additionally reproduced `ERR_STRING_TOO_LONG` in Codex catch-up for an oversized rollout. Restart safely by processing a fixed file snapshot in bounded UTF-8 line batches, retaining the existing parser, offsets, partial-line tail and lifecycle behavior. Cover batching, Unicode/CRLF, partial writes, truncation and growth during consumption; rerun Codex hierarchy/lifecycle checks and native boot before deployment.
