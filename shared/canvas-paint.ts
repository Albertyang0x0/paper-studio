// SVG's `none` is not a CSS canvas color. Fabric expects a falsy paint value
// to skip drawing; passing `none` leaves the context's previous color active.
export function canvasPaint(
  value: string | undefined,
  fallback?: string,
): string | undefined {
  const paint = value ?? fallback;
  return paint?.trim().toLowerCase() === "none" ? "" : paint;
}
