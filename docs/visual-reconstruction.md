# Editable visual reconstruction

The default method-overview pipeline first produces three Gemini image proposals, selects a scientifically faithful visual blueprint, then reconstructs it as native editable objects. The image is not placed underneath the SVG or embedded as its visible content.

## Pipeline

1. Ground the scientific components and relationships in uploaded materials.
2. Write a detailed content-adaptive visual brief and generate three image proposals.
3. Decompose the selected image into background layers, semantic objects, text, curved connections and reusable illustrations.
4. Independently locate objects using Gemini's normalized `box_2d` convention `[ymin,xmin,ymax,xmax]` on a 0–1000 scale. Convert all axes and extents to native pixels in code. Do not give this detector previous approximate boxes: they can anchor the model to incorrect coordinates.
5. Locally re-detect tiny illustrations inside enlarged parent crops; full-page boxes can truncate a bulb or target. Parallel node specialists reconstruct text and basic geometry from the full blueprint plus local crops. Illustration specialists produce bespoke groups of native paths and shapes from illustration-only crops.
6. A deterministic compiler places specialist elements into declared slots. An assembler checks actual rendered composition without redesigning the layout.
7. Closed-outline measurement and source-stroke routing refine the native geometry. Decision ports meet the actual polygon outline, not its rectangular bounding box. Palette sampling restores fills, native gradients and dashed strokes. A typography tool fits native font size/position while masking pictogram ink and rejecting new text/icon collisions; it never substitutes wording, uses a condensed font as a fitting trick, or traces glyphs. A visual/scientific critic compares the blueprint and the rendered SVG. Proposed geometry edits are independently checked against actual changed-pixel error and measured typography; worsening edits are rejected individually. Local specialist repairs are iterated. A failed visual check remains `needs-revision`, not an approved result.

Text, shapes, illustration parts, gradients, and cubic connections stay editable. Moving a connected node adjusts curve endpoints and controls. Statistical plots continue to use source-cell-bound chart generation; this mechanism does not infer experimental data from a generated image.

## Code boundaries

- `server/visual/prompts.ts`: brief, decomposition, detection, native-object specialists, assembler and critic contracts.
- `server/visual/reconstruction.ts`: execution, bounded parallelism, caching and review loops.
- `server/visual/compiler.ts`: coordinate conversion, compilation, semantic ownership and safe edits.
- `server/visual/local-geometry.ts` and `surface.ts`: enlarged illustration detection, background layers, native curve routes and editable grouping anchors.
- `server/visual/outline-fit.ts`, `port-fit.ts`, `marker-fit.ts`, and `route-fit.ts`: native closed-box/badge calibration, polygon-edge anchors, and source-supported curved routes.
- `server/visual/paint.ts`, `typography-fit.ts`, `type-obstacles.ts`, `visual-guard.ts`, and `text-guard.ts`: rendering/palette tools that validate proposed visual improvements.
- `server/visual/image-model.ts`: provider-routed image generation and crop preparation; protocols are described in [API connections](API_CONNECTIONS.md).
- `shared/visual-contract.ts`: inter-agent object/illustration contracts.
- `shared/svg.ts` and `src/figure/CanvasEditor.tsx`: SVG/native-canvas rendering of identical editable primitives.
- `server/paper/figures.ts`: paper-module integration; no changes to accepted prose or figures without candidate acceptance.

The old independent vector-design method remains selectable. In the figure editor, choose the generation pipeline, image model, role models and number of comparison passes in the generation dialog. Use “视觉方案” to inspect the selected raster proposal separately from the editable board. Gradients, curve control points and line weights can be edited in the selected object's property panel.

## Paid calibration trials

The original workspace's `scripts/iterate-visual.ts` is a local paid-calibration tool tied to private research inputs. It is not distributed in the GitHub source package. Collaborators should use their own authorized inputs in the workbench; the source regression tests use only synthetic fixtures and mocks.

Without a reference, the script tests the complete image-design-to-editable-object chain. With `--reference IMAGE`, it calibrates editable reconstruction of that existing image instead. These are different tests; a successful reference reconstruction does not by itself verify the image-design stage.

Trials write only to `archives/visual-development/<UUID>`, including API usage, raw plans, native objects, rendered comparisons and recovery checkpoints. They do not replace a live manuscript or its assets. Resume a trial with `--directory DIR --resume`; completed node and illustration tasks are reused. `--recalibrate` re-detects geometry and invalidates only affected object/crop caches. `--snapshot` renders an explicitly incomplete diagnostic image without model calls.

Run `npm test`, `npm run build`, and the isolated `npm run test:ui` regressions before deployment. Set `PAPER_TEST_PYTHON` to a Python executable with Playwright for GUI checks.

Visual approval is a model review signal, not a guaranteed conference acceptance standard. Inspect the actual reconstruction and its exported SVG before declaring a quality trial successful.

References: [PaperOrchestra figure stages](https://github.com/google-research/paper-orchestra/blob/main/utils/paper_banana_utils.py), [Gemini normalized detection coordinates](https://ai.google.dev/gemini-api/docs/image-understanding).
