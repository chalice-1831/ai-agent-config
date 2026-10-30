---
description: Save an insight, decision, or learning to agentmemory
argument-hint: "[what to remember]"
---

Explicitly save an insight, decision, or learning to agentmemory for future sessions using the `memory_save` MCP tool.

What to remember: $ARGUMENTS

1. Analyze what needs to be remembered — extract the core insight, decision, or fact.
2. Extract 2-5 searchable concepts (lowercased keyword phrases). Prefer specific terms ("jwt-refresh-rotation" over "auth").
3. Extract relevant file paths the memory references.
4. Call `memory_save` with:
   - `content` — full text to remember (preserve user's phrasing).
   - `concepts` — extracted concept list.
   - `files` — extracted file list (empty array if none).
   - `type` — choose from: pattern, preference, architecture, bug, workflow, fact.
5. Confirm the save and show the concepts tagged so the user knows retrieval terms.
