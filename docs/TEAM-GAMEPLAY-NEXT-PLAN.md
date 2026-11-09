# Team gameplay — later milestone

Status: follow-up scope, not implemented or verified by the Individual milestone. The accepted 6 November 2026 plan keeps remote Team selection/settings/starts disabled. Preserve existing Team types, engine branches, stored records and explicitly deferred tests until this work is scheduled.

## Starting point

Use the completed Individual authority, authenticated transport, RoomClient, canvas journal/outbox and commit/recovery rules. Do not create another backend or weaken Individual behavior. The earlier Team design in SYSTEM-DESIGN.md remains design context: explicit selection, stable teams, rotating shared-target selector and private team canvases. Reconcile those branches with the current contracts before enabling them.

## Work sequence

1. Review the preserved Team implementation against the agreed formats, minimum connected members, selector/drawer rotation and shared-target/private-canvas rules. Record any unresolved gameplay decisions before changing behavior.
2. Add authoritative Team settings/start validation, private channel projections and independent team challenge closure. Keep Individual eligible-roster and all-human-solve rules separate from Team's earlier first-solve design.
3. Extend committed scoring/results, departures, host changes, pauses and restart retry for parallel team canvases. Define any unresolved Team scoring policy explicitly rather than inheriting Individual AI adjustments.
4. Enable Team controls only after real multi-browser Team coverage passes. Restore the deferred tests as active acceptance tests and add browser-level privacy, reconnect and recovery coverage.

## Acceptance

Exercise each supported format, unauthorized cross-team reads/writes, private canvas pixels, selector/drawer rotation, simultaneous outcomes, disconnected team members, exact committed totals, final standings and another lobby game. Kill/restart the real API against isolated PostgreSQL and verify per-canvas committed prefixes, fresh retries and archived drawings. Re-run Individual regressions and retain the current frontend CI coverage/cache/timeouts.

Real inference remains a separate dependency. Team gameplay can be verified with the unavailable provider and explicitly labelled synthetic fixtures.
