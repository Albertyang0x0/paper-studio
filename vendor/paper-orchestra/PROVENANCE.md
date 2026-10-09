# Selective PaperOrchestra reuse

Upstream: https://github.com/google-research/paper-orchestra

Pinned commit: `ca1b3fa01c2970fc7cda32d16245db38d57b3f56`

This directory contains only four original prompt files, their shared knowledge-isolation prompt and the Apache-2.0 license. It is not a clone of the application or its Streamlit frontend. Original files remain unmodified, with copyright headers intact.

Runtime: `server/paper/adapters.ts` extracts prompt constants without executing Python and appends explicit module-scoped contracts. It changes full-document LaTeX output to single-module Markdown, removes forced citation quotas as a requirement, forbids invented experiments/authors, and explicitly discloses missing evidence and limitations. The adapter contract overrides contradictory upstream instructions, including hiding limitations or silently ignoring missing experimental evidence.

The literature adapter is an independently implemented, attributed adaptation of discovery → retrieval → deduplication → citation-library organization. It queries Semantic Scholar directly, does not reproduce Gemini Google Search grounding, and does not claim that metadata verification validates every cited scientific statement.

No upstream frontend, writer executable, model weights, example dataset, PaperBanana images or conference template assets are included.
