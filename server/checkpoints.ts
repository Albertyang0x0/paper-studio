import type { PlanningCheckpoint, RunInput } from "../shared/types";
import { validateSemantic } from "./validation";

export function validatePlanningCheckpoint(
  checkpoint: PlanningCheckpoint,
  input: RunInput,
) {
  if (
    checkpoint.intent !== input.intent ||
    checkpoint.figureType !== input.figureType ||
    checkpoint.materials.length !== input.materials.length ||
    checkpoint.materials.some(
      (old) =>
        !input.materials.some(
          (m) => m.name === old.name && m.content === old.content,
        ),
    )
  )
    throw Error(
      "Materials or figure intent changed. Redesign rather than reusing a stale science plan.",
    );
  validateSemantic(
    checkpoint.semanticPlan,
    new Set(input.materials.map((m) => m.name)),
  );
}
