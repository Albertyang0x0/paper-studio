import type { Primitive } from "./types";
export function objectIsLocked(
  items: Primitive[],
  id: string,
  inherited = false,
): boolean {
  for (const e of items) {
    const locked = inherited || !!e.locked;
    if (e.id === id) return locked;
    if (e.children?.some((c) => c.id === id || hasId(c, id)))
      return objectIsLocked(e.children, id, locked);
  }
  return false;
}
function hasId(e: Primitive, id: string): boolean {
  return e.id === id || !!e.children?.some((c) => hasId(c, id));
}

// Preserve the entire ancestor transform, not merely the leaf's local x/y.
// A regenerated group is not allowed to move a locked child indirectly.
export function preserveLockedObjects(
  previous: Primitive[],
  generated: Primitive[],
): Primitive[] {
  const protectedIds = new Set<string>(),
    anchors: Primitive[] = [];
  const ids = (e: Primitive) => {
    protectedIds.add(e.id);
    for (const child of e.children ?? []) ids(child);
  };
  const collect = (items: Primitive[], parents: Primitive[]) => {
    for (const e of items) {
      if (e.locked) {
        ids(e);
        let anchored = structuredClone(e);
        for (let i = parents.length - 1; i >= 0; i--)
          anchored = {
            ...structuredClone(parents[i]),
            id: `__locked-anchor-${e.id}-${i}`,
            locked: false,
            children: [anchored],
          };
        anchors.push(anchored);
      } else if (e.children) collect(e.children, [...parents, e]);
    }
  };
  collect(previous, []);
  if (!anchors.length) return generated;
  const prune = (items: Primitive[]): Primitive[] =>
    items
      .filter((e) => !protectedIds.has(e.id))
      .map((e) => ({
        ...e,
        children: e.children ? prune(e.children) : undefined,
      }))
      .filter((e) => e.type !== "group" || !!e.children?.length);
  return [...prune(generated), ...anchors];
}
