
# Referee outputs and advisory policy

The Referee separates text and numbers, uses the Guesser's canvas renderer, and leaves rule decisions to players. The deployed v2 model supplies these scores; the private fixture remains for isolated tests.

| Target `[text, number]` | Example | Advisory |
|---|---|---|
| `[0, 0]` | A drawing, arrows, circles or icons with neither text nor digits | None |
| `[1, 0]` | `CAT` beside a cat or `STOP` on a drawn sign | Writing detected by referee |
| `[0, 1]` | `12` on a drawn clock | None. The number score stays internal. |
| `[1, 1]` | A word and digits together | Writing detected by referee |

Each slot answers a binary presence question. The model produces two scores, so a canvas can score high on both. The order is always text, then number. Text covers letters, initials and words. Number covers visible numerals. Use a separate threshold for each score and tune both with validation data.

Both a written answer and incidental object writing have text target `1`. The first score detects the visible content, and players decide whether it was a prohibited clue. Advisory events carry zero score effects.

The current warning opens on the first fresh text score of at least **0.3**. No consecutive-frame confirmation is required. The badge shows that text confidence and expires after three seconds without qualifying evidence. A clean or blank frame, canvas clear, pause, inference failure, or turn end also clears it. The lower cutoff may increase false advisories and remains a gameplay choice pending evaluation on game drawings. See the [validation and inference plan](validation-inference-plan.md).

The model consumes the same prepared canvas as the Guesser. The visible image supplies the presence evidence, while policy and advisory state belong to the backend. See the [model and input plan](referee-model-plan.md).
