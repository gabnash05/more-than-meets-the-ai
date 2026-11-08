
# Referee outputs and advisory policy

The latest Lavish feedback separates text and numbers, uses the Guesser's canvas input and leaves rule decisions to players. This supersedes the interim proposal to merge letters and digits into one global-ban label.

| Target `[text, number]` | Example | Advisory after persistence |
|---|---|---|
| `[0, 0]` | A drawing, arrows, circles or icons with neither text nor digits | None |
| `[1, 0]` | `CAT` beside a cat or `STOP` on a drawn sign | Possible written clue detected. |
| `[0, 1]` | `12` on a drawn clock | Possible numbers detected on the canvas. |
| `[1, 1]` | A word and digits together | Each channel can qualify independently |

Each slot answers a binary presence question. The model produces two scores, so a canvas can score high on both. The order is always text, then number. Text covers letters, initials and words. Number covers visible numerals. Use a separate threshold for each score and tune both with validation data.

Both a written answer and incidental object writing have text target `1`. The first score detects the visible content, and players decide whether it was a prohibited clue. The numeric advisory can use a stricter threshold or a different persistence setting according to the agreed rules. Arrows, circles and other icons alone qualify for neither advisory. Advisory events carry zero score effects.

For the first replay experiment, require **two consecutive fresh timed observations** above that channel's opening threshold at least one second apart, with a maximum three-second gap. Treat these values as starting parameters for validation. Observation IDs and timestamps filter retransmissions. A fresh confirmation of the same unchanged canvas can count as duration evidence. Keep separate incident state for text and numbers, and clear it on clear, restart or turn close. A delayed or unavailable observation supplies no evidence. Details and tradeoffs are in the [validation and inference plan](validation-inference-plan.md).

The model consumes the same prepared canvas as the Guesser. The visible image supplies the presence evidence, while policy and advisory state belong to the backend. See the [model and input plan](referee-model-plan.md).
