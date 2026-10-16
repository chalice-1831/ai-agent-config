# AGENTS.md Reminder Hook

This hook adds a short, non-blocking system reminder to normal model calls.

- Injects once every 10 outgoing model calls per session.
- Injects once on the first normal model call after `session.compacted`.
- Deduplicates compaction and periodic triggers by resetting the counter after injection.
- Does not count compaction-summary model calls.
- Does not read or inject local `AGENTS.md` files.
- Skips injection when `~/.config/opencode/AGENTS.md` is absent.
- Keeps state in memory and logs only trigger metadata.

The hook is intentionally separate from `memory-activation-reminder`.
