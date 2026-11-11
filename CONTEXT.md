# Domain glossary

Milestone terminology updated 6 November 2026. Individual is the current remote milestone. Team-specific terms below are preserved for the separate later Team plan; they do not authorize Team starts now. Actual AI inference is unavailable, and human AI modifiers remain zero.

## AI benchmark round result
A separate versioned ai-benchmark-v1 result for the AI's own raw speed points. A first valid eligible correct answer uses the human raw speed formula; eligible no-solve is zero, while unavailable/ineligible is unscored with null points. This is not human or drawer recognition credit.

## AI benchmark summary
The committed AI total plus scored, solved and completed prompt counts. The total is null until at least one eligible result commits. Interrupted unfinished generations do not contribute; older committed results remain after restart. Render this comparison alongside human standings; human totals determine human winners. Humans rotate roles while AI is a guesser, so game points are not a controlled model-performance result.

## Provider boundary
The typed internal job/observation/result interface reserved for a later AI service or server. It excludes the private target, binds identity/generation/sequence/deadline, and returns guesses or unavailable status rather than scores. The game authority validates and scores. The production adapter currently reports unavailable.

## Individual mode
The default free-for-all format: one rotating drawer, one shared canvas, independently competing human guessers, a shared AI benchmark and personal scores. Drawer and guessers are not teammates.

## Selected prompt history
For newly started matches, private persisted `selectedPrompts` records targets selected manually or automatically, including interrupted attempts. Later drawers receive three unused choices; unselected alternatives remain eligible. History survives refresh/restart/retry and resets for another game. Older matches without this field retain their legacy behavior because earlier chosen targets were not recorded. The history is never included in public snapshots.

## Ranking
Human standings preserve authoritative score order. Equal scores share competition ranks (for example 1, 1, 3), and every tied winner is shown. AI remains a separate benchmark comparison. Relative score bars are visual aids; they do not compute winners or additional points.

## Round recap
The committed round reveal shows the target, earned points and relevant components, round gains, upcoming drawer and authoritative countdown. A confirmed correct chat message is green and labelled; it does not reveal the target to remaining unsolved humans.

## Drawing turn
One drawer's opportunity to depict one secret target while other eligible humans and the AI guess. It continues after the first human solve and ends when all eligible humans have solved or the deadline expires, subject to explicit abandonment rules.

## Personal solve order
The authoritative order of an individual's correct answer relative to the AI's first accepted correct answer. An AI answer accepted later does not erase that human's earlier success.

## After-AI reduction
A smaller reward for a correct human solve accepted after the AI solved. It affects that turn's earnings, not previously earned totals; numeric weights remain to be tuned.

## Drawer recognition points
The drawer's ordinary personal reward for humans correctly identifying the drawing. AI recognition and simply keeping everyone confused do not earn it.

## Drawer AI bonus
A smaller, capped reward tied to the share of eligible humans who recognized the drawing before the AI. It supplements successful human communication and does not replace ordinary drawer recognition points.

## Team
In optional team mode, a group of at least two human players competing together. Team sizes may differ. Individual mode has no human teams, including no implicit team containing the whole room.

## Drawer
The player assigned to draw the secret target during a drawing turn. In default individual mode the drawer competes for their own points and is not a teammate of the guessers.

## Human guesser
An eligible non-drawer who identifies the target from the evolving canvas and official hints. In individual mode each guesser has an independent result; their first correct answer ends only their own guessing, not the whole turn.

## AI guesser
The transformer-powered competitor observing the permitted canvas and hints with a capped guess budget. Default individual play has one logical AI race for the shared drawing turn; optional team mode assigns a logical competitor per team canvas.

## Shared prompt
The secret target depicted in a drawing turn. In optional parallel team mode, all teams receive the same fresh target for that round.

## Parallel team challenges
Optional team-mode races played simultaneously on private team canvases. They are not the default individual mode.

## Team canvas
A private canvas belonging to one team in optional team mode. Individual mode instead uses one shared canvas visible to all room players.

## Opponent progress
Visible solve/AI status without disclosing the hidden answer. Default individual play shows personal progress; optional team play also shows opposing team status while hiding private canvases.

## Human solve
A human's first correct accepted guess for a drawing turn. In individual mode it creates that player's personal result; it never solves the turn for everyone else.

## Speed points
Current `human-v1` points depend on how quickly an individual human solves, measured from the start of drawing with paused time excluded. Human AI modifiers stay zero. Before/after-AI weighting is future design context; optional Team scoring is deferred.

## Beat-the-AI bonus
An AI-related positive score component when a human solves before the AI's accepted correct answer. Default guesser credit is personal; the drawer's separate bonus is smaller and capped. Optional team mode retains one team bonus. Required AI-service failure neutralizes default-turn AI bonuses and reductions while retaining human-only scoring.

## AI guess
An answer proposed by the AI. Actual answer text remains hidden from unsolved humans until reveal/replay. It is never a human solve or ordinary drawer-score contribution.

## AI progress
The AI card pulses red for a wrong prediction and green for a correct one. The committed recap shows each accepted guess and its model confidence.

## Replay
The retrospective revealing the drawing's development, human/AI solve timing, attempts and flags after the drawing turn ends.

## Visual strategy
Any drawing-based way to communicate the shared prompt, subject to the prohibition of written answer clues.

## Written answer clue
A prohibited written hint used to communicate the prompt, such as spelling the answer, writing initials or a translation, or supplying letter-by-letter hints.

## AI referee
An optional classifier role that shares the Guesser's canvas renderer and reports text and number evidence. The private fixture exercises the Referee pipeline while trained weights are unavailable.

## Incidental writing
Permitted writing that belongs to an object being depicted, rather than being used as a written hint to communicate the prompt.

## Referee flag
An advisory board glow and confidence badge for persistent text detection. Players decide whether the writing is a prohibited clue or incidental to the drawing.

## Referee dispute
A disagreement about whether flagged content is a prohibited written answer clue or permitted drawing content, resolved by the players.

## Team challenge
In optional team mode, one team's race ending at its first correct human solve, forfeit or timeout. It is not the default individual turn-completion rule.

## Round
One configured prompt position: one drawing turn in individual mode, or simultaneous private team challenges in optional team mode. The lobby count is total prompt rounds, not complete player rotations. A voided/interrupted generation does not consume this position.

## Role rotation
In individual mode, drawer duty passes through the room players after a completed drawing turn. Optional team mode rotates drawers within each team. An individual solve alone never advances rotation.

## Match
A scheduled contest won by the human with the highest finalized personal total in default individual mode. Optional team mode uses finalized team totals instead.

## AI guess budget
The maximum number of AI guesser attempts available for a drawing turn. The default is 24 attempts, with at least two seconds between settlement and the next attempt.

## AI guess checkpoint
A scheduled opportunity to infer from a frozen permitted drawing and hint state. In default play opportunities continue after the first human solve while other eligible humans remain unsolved.

## Prompt pool
The collection of familiar, everyday drawable concepts from which shared prompts are randomly selected. Its vocabulary follows the style of ordinary skribbl.io prompts and is intended to cover concepts the AI could reasonably recognize.

## Official hints
Word length and progressively revealed letters. Human and AI guessers receive the same permitted hint state and schedule for their drawing turn.

## Sketch-focused comparison
A research comparison of human and AI recognition of the same incomplete sketches, separate from the party game's timed letter hints and AI guessing handicap.

## Recognition speed
How early a human or AI supplies a correct identification during a drawing's development. It is a secondary research outcome and does not directly establish an internal moment of understanding.

## Direct depiction
A sketch that represents the target itself.

## Indirect visual reference
A sketch that communicates the target through a related object, scene, character, or symbol, rather than depicting the target itself.

## Shared association
A semantic or cultural connection that an interpreter may recognize without a private agreement with the drawer, such as cow to milk or Minion to banana.

## Private visual code
A prearranged mapping between a visual mark and a meaning known to particular players. It is permitted as a visual strategy in the game but excluded from the main sketch-focused comparison.

## Target correctness
Whether a guess correctly identifies the intended prompt, considered separately from an explanation of the visual reference.

## Reference interpretation
An account of the recognized visual cue and its semantic or cultural connection to the target. It is distinct from simply naming the target correctly.

## Team format
An explicitly selected optional-mode arrangement such as 2v2 or 3v2v4. It is never inferred from an individual room or used as the default.

## Team solve
The first teammate correct guess in optional team mode, closing that team's challenge and creating one team result. This concept must not replace per-player solves in individual mode.

## Reconnect grace
A 30-second chance for a disconnected drawer, or all remaining unsolved human guessers, to return while the affected drawing clock is paused. Accepted individual solves remain personal. On expiry close the affected turn/challenge with human outcomes retained. Host recovery also lasts 30 seconds; explicit host departure transfers authority immediately.

## Team forfeit
An optional team-mode outcome when an active challenge has no recovered eligible human guesser before grace expires. It does not apply to all individual players when one person disconnects.

## Round finalization
Confirmation of the applicable turn/round results after their required records are saved. Individual totals use committed per-player results; team totals are mode-specific.

## Voided round
An unverifiable competitive turn/round whose provisional scores are discarded. Default play retries the same drawing-turn position and drawer with a fresh target; prior committed personal results remain.

## AI guesser unavailable
A required AI attempt missing because of a service fault, distinct from a wrong guess or normal cancellation. Default play uses human-only turn scoring with all AI adjustments neutralized; optional team mode removes AI bonuses across its affected round.

## Game start countdown
Host Start enters a shared three-second countdown before the first private word selection. The authority publishes its deadline and checks connected-player eligibility again before advancing. Later drawing turns retain normal selection and recap timing.

## Prediction versus submitted AI guess
A valid prediction is the model answer and confidence from a permitted observation. Only confidence strictly greater than 0.5 makes it a submitted answer eligible to solve or score. Low-confidence predictions remain recorded for revealed history, use the same call budget/cooldown and do not trigger an answer pulse. Missing confidence does not qualify. Legacy recorded guesses retain their historical meaning.

## Completed-round AI history
The authorized snapshot exposes committed rounds with the revealed target, drawer, AI benchmark and chronological prediction list. Predictions include active elapsed time and submission status when recorded by the current implementation. Active targets/predictions and interrupted generations are excluded. Final results let players expand each completed round; this is a game retrospective, not a controlled model evaluation.
