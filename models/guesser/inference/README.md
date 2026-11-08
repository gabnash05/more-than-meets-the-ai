# Guesser inference

The CPU service loads one validated Guesser bundle at startup. The pinned LiteRT INT8 bundle is an explicitly enabled integration smoke model. Its training bitmaps use light strokes on a dark background, and the interpreter supplies tensor quantization.

The optional ViT-Tiny adapter reuses the selected training preprocessor, ordered labels and a validation-selected, safely exported state dict. Serving readiness requires a compatible bundle. Compare predictions against the evaluation pipeline once trusted weights arrive.

See the [deployment runbook](../../../deploy/README.md) for setup and bundle fields.
