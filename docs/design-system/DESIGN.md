# Lemon Crayon
Version 1.0.0 · Static design foundations

A warm, saturated design system inspired by the colorful drawing-game character of skribbl.io. Lemon yellow is the base; eight crayon colors, rounded lettering, and imperfect ink lines give this system its own identity.

## Files
- `index.html`: the static visual reference. Open it directly in a browser.
- `tokens.css`: reusable CSS custom properties and local font declarations. Load this in your project.
- `tokens.json`: equivalent portable values, semantic aliases, and descriptive mood metadata.
- `assets/fonts/`: local Fredoka and Nunito font files and their SIL Open Font License texts.

CSS and JSON use the same primitive values. JSON aliases such as `{color.yellow}` are symbolic references: resolve them in your own token tooling. CSS aliases resolve natively through `var()`. JSON mood strings are descriptive guidance, not CSS declarations. The numeric names in the type and spacing scales express their nominal pixel size at a 16px root; CSS uses rem so they follow user font scaling.

## Color
| Token | Hex | Recommended foreground |
| --- | --- | --- |
| red | #FF4343 | ink |
| orange | #FF8A1F | ink |
| yellow | #FFE83D | ink |
| green | #37D66B | ink |
| cyan | #27DCEB | ink |
| blue | #3455FF | paper |
| purple | #853BE8 | paper |
| pink | #FF57B5 | ink |
| ink | #181321 | paper |
| paper | #FFFFFF | ink |
| neutral | #F4F4F6 | ink |

Semantic aliases:
- `base` → yellow; use for the signature opening surface and selected emphasis.
- `surface` → paper; let detailed content breathe.
- `text` and `outline` → ink.
- `accent` → orange.
- `on-bright` → ink, for red, orange, yellow, green, cyan, and pink.
- `on-dark` → paper, for blue, purple, and ink.

Keep body text in ink on paper or the approved bright swatches. White text belongs on blue, purple, or ink. Do not use yellow, cyan, orange, or other bright primitives as small text on white. Pair color distinctions with written names, shapes, or other visible labels. Color values are not a status taxonomy; red does not automatically mean error. These specified pairings target at least 4.5:1 body-text contrast.

## Type
- Display: Fredoka, weight 600 or 700. Rounded, chunky, friendly.
- Body: Nunito, weight 400, 700, or 800. Soft but readable.
- Fallback for both: "Arial Rounded MT Bold", system-ui, sans-serif.
- Scale: 16, 20, 24, 32, 48, 64px, expressed in rem.
- Line height: 1.6 for body; 1.1 for display.
- Reading width: up to 68ch on desktop, approximately 38ch on mobile where available width permits.
- Use a responsive 48–64px headline; wrap it naturally. Never truncate authored headings.
- Local files supply only the declared weights; avoid requesting synthetic intermediate styles.

## Space
Use 4, 8, 12, 16, 24, 32, 48, 64, and 96px, expressed in rem.
- 4–8: close relationships, small labels, small decorative spacing.
- 12–16: nearby elements and compact insets.
- 24–32: grouped samples and ordinary section content.
- 48–64: section separation and generous panels.
- 96: large canvas breathing room when space permits.

Compact layouts change the gaps, not the minimum body font size.

## Layout stability
The room is a live surface: snapshots arrive several times a second, so anything whose text changes must not change the size of the box around it.

- Panels below the board (tools, chat, AI card) keep a fixed height, so a status change never moves them.
- Transient status — saving, queued changes, canvas ready — sits on the board as a capsule, out of the column flow. Long copy truncates; the full sentence lives in `title`. It never wraps to a second line.
- A label that appears and disappears (the attention legend's caption) keeps its slot and toggles visibility instead of presence.
- Widths come from `minmax(0, 1fr)` grid tracks and `aspect-ratio` on the board, so the same structure holds from 390px to 1680px without reflowing at a breakpoint.
- Dynamic content goes inside a reserved box; it never gets to push the layout. Verify a change by measuring element boxes over a live round, not by eye.
- Colour is evidence, so it must sit on the thing it describes. An overlay that tints empty paper is decoration; mask it to the marks it explains (`mix-blend-mode: screen` over ink on white). Any caption that carries the meaning — "attention, not its reasoning" — stays visible, never a tooltip.
- Hints are yellow stickers: `--color-base` fill, 2px ink outline, 12px radius, a 10px diamond arrow in the same fill with ink on two sides. Typed Nunito 700 at 12px, 228px wide, never a shadow. They open on hover where hover exists and on keyboard focus; on a touch screen they stay closed, because a stuck tip covers the board. The text is always in `aria-describedby`, so nothing depends on seeing it.

## Roundness
Small 12px; medium 24px; large 32px; extra-large 48px; capsule 9999px.
Use larger radii for larger surfaces. A capsule is deliberately round, not an accidental default for every region.

The blob uses `48% 52% 44% 56% / 54% 46% 54% 46%`. Keep it decorative; do not force long text into an irregular boundary.

## Shapes and ink
Use 2px fine or 4px bold outlines in ink, with round caps and joins. Keep the mark-making gently imperfect, not noisy. No shadows are needed.

The wave and outline path definitions live in both token files:
- Wave: 240 × 36 viewBox; a static underline or standalone divider.
- Outline: 240 × 96 viewBox; an uneven rounded enclosure.
- Double-sketch treatment: use the outline path twice, with a slight inset on the second path.
- Capsule and blob: native CSS radius tokens.

The CSS path tokens can be applied to SVG paths using `d: var(--shape-wave)` or `d: var(--shape-outline)`. For renderers without CSS SVG path support, use the corresponding JSON path as the SVG `d` attribute. Stroke dimensions, caps, and joins remain token-based.

Keep decoration away from important text and controls. Unevenness belongs in the outline, not the alignment of content. Keep content in normal flex or grid flow.

## Mood
Playful · informal · bright · tactile · deliberately imperfect.

Write like a friendly person: short, clear, inviting. “Make your mark.” fits; exaggerated business claims do not. Use a generous white surface alongside the lemon ground so eight saturated colors remain distinct. Show colors in purposeful clusters rather than making every line of text a different color.

## Scope
Only colors, fonts, spacing, border radii, shapes, and mood are defined. There are no motion, animation, transition, duration, or easing tokens. The specimen is static, with native section links and file links only. This is not a game interface or a component library.

## Provenance and assumptions
Reference: https://skribbl.io/ and https://skribbl.io/css/style.css (accessed November 3, 2026). Its stylesheet identifies Nunito and a #124da5 body background. The supplied brief establishes the multicolor, rounded, hand-drawn inspiration. This system's eight hex values are original selections, not an exact sampled palette.

Lemon yellow rather than orange was selected from the user's permitted warm-base choices. Fredoka, spacing, radius values, and shape definitions are design decisions made for this system. No Slack tokens apply. No skribbl.io logo or artwork is reproduced.

Fonts: Fredoka and Nunito from Google Fonts; corresponding OFL texts are retained locally. The reference uses local assets and does not require a network connection after download.

The source was written directly; no post-generation preview, rendering, or automated validation was performed.
