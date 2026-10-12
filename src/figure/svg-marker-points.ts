import type { util } from "fabric";

type Point = { x: number; y: number };
export type SvgMarkerPoint = Point & { side: "start" | "mid" | "end"; angle: number };
type Segment = { start?: number; end?: number };
type Subpath = { points: Point[]; segments: Segment[]; closed: boolean; following?: Subpath };

const direction = (from: Point, to: Point): number | undefined =>
  from.x === to.x && from.y === to.y ? undefined : Math.atan2(to.y - from.y, to.x - from.x);

function bisect(incoming: number, outgoing: number): number {
  let turn = outgoing - incoming;
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;
  return incoming + turn / 2;
}

/**
 * SVG vertex markers in path order, with angles in radians. Start/end apply
 * only to the whole path; intermediate subpath endpoints receive mid markers.
 * https://www.w3.org/TR/SVG/painting.html#MarkerVertex
 */
export function markerPoints(path: ReturnType<typeof util.makePathSimpler>): SvgMarkerPoint[] {
  const subpaths: Subpath[] = [];
  const vertices: { point: Point; subpath: Subpath; index: number }[] = [];
  let current: Subpath | undefined;
  let position: Point = { x: 0, y: 0 };
  const begin = (point: Point, addVertex: boolean) => {
    const subpath: Subpath = { points: [point], segments: [], closed: false };
    subpaths.push(subpath);
    if (addVertex) vertices.push({ point, subpath, index: 0 });
    return subpath;
  };
  for (const command of path) {
    if (command[0] === "M") {
      position = { x: command[1], y: command[2] };
      current = begin(position, true);
      continue;
    }
    if (!current) continue;
    if (current.closed) {
      // A drawing command after Z starts a new subpath at the same vertex.
      // That vertex already exists, so it must not gain a duplicate marker.
      const previous = current;
      current = begin(position, false);
      previous.following = current;
    }
    let end: Point, startDirection: number | undefined, endDirection: number | undefined;
    if (command[0] === "C") {
      const c1 = { x: command[1], y: command[2] }, c2 = { x: command[3], y: command[4] };
      end = { x: command[5], y: command[6] };
      startDirection = direction(position, c1) ?? direction(position, c2) ?? direction(position, end);
      endDirection = direction(c2, end) ?? direction(c1, end) ?? direction(position, end);
    } else if (command[0] === "Q") {
      const control = { x: command[1], y: command[2] };
      end = { x: command[3], y: command[4] };
      startDirection = direction(position, control) ?? direction(position, end);
      endDirection = direction(control, end) ?? direction(position, end);
    } else {
      end = command[0] === "Z" ? current.points[0] : { x: command[1], y: command[2] };
      startDirection = endDirection = direction(position, end);
    }
    current.segments.push({ start: startDirection, end: endDirection });
    current.points.push(end);
    vertices.push({ point: end, subpath: current, index: current.points.length - 1 });
    current.closed = command[0] === "Z";
    position = end;
  }
  // Resolve each zero-length segment in linear time. Its starting direction
  // follows the closest preceding segment; its ending direction follows the
  // closest following segment. Missing directions borrow the opposite side.
  // https://www.w3.org/TR/SVG/paths.html#PathDirectionality
  for (const subpath of subpaths) {
    const previous: Array<number | undefined> = [], following: Array<number | undefined> = [];
    let before: number | undefined, after: number | undefined;
    for (let i = 0; i < subpath.segments.length; i++) {
      previous[i] = before;
      before = subpath.segments[i].end ?? before;
    }
    for (let i = subpath.segments.length - 1; i >= 0; i--) {
      following[i] = after;
      after = subpath.segments[i].start ?? after;
    }
    subpath.segments.forEach((segment, i) => {
      segment.start ??= previous[i] ?? following[i] ?? 0;
      segment.end ??= following[i] ?? previous[i] ?? 0;
    });
  }
  const result = vertices.map(({ point, subpath, index }, i): SvgMarkerPoint => {
    const segments = subpath.segments;
    let incoming = segments[index - 1]?.end, outgoing = segments[index]?.start;
    if (subpath.closed && (index === 0 || index === segments.length)) {
      incoming = segments.at(-1)?.end;
      outgoing = index === segments.length && subpath.following
        ? subpath.following.segments[0]?.start
        : segments[0]?.start;
    }
    const angle = incoming === undefined ? outgoing ?? 0 : outgoing === undefined ? incoming : bisect(incoming, outgoing);
    return { ...point, side: i === 0 ? "start" : i === vertices.length - 1 ? "end" : "mid", angle };
  });
  if (result.length === 1) result.push({ ...result[0], side: "end" });
  return result;
}
