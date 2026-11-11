# Referee inference

`vit.RefereeViT` supports legacy v1 four-output bundles and `referee-vit-v2` two-output bundles. V2 validates preprocessing config/hash, provenance, and bundle file hashes and returns text and number scores in that order. Canvas preprocessing comes from `referee_data` for v2. Blank/uncertain inputs report no evidence.

The service-level loader in `apps/ai` must separately accept and validate manifest version 2 before it can serve these bundles. This adapter change alone does not enable production serving. Referee output remains advisory; number scores do not affect game scoring.
