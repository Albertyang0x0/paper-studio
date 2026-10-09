import type { FigureScene, Point } from '../../shared/types';

/** Native decision polygons do not have rectangular borders. Project a declared
 * side port onto the actual polygon outline along that side's axis. Its anchor
 * remains fractional and therefore follows subsequent human moves/resizes. */
export function fitPolygonPorts(original: FigureScene) {
  const scene = structuredClone(original), audit: {nodeId:string;portId:string;before:Point;after:Point}[] = [];
  for (const module of scene.modules) {
    if (module.locked) continue;
    const shape = module.elements.find(e => e.type === 'polygon' && e.points && e.points.length >= 3 && e.fill && e.fill !== 'none');
    if (!shape || shape.locked || shape.rotation || shape.scaleX || shape.scaleY) continue;
    const width = module.contentWidth ?? module.width, height = module.contentHeight ?? module.height;
    const points = shape.points!.map(p => ({x: (p.x + shape.x) / width, y: (p.y + shape.y) / height}));
    if (Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x)) < .65
      || Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y)) < .65) continue;
    for (const port of module.ports) {
      if (!scene.connectors.some(c => c.from === module.id && c.fromPort === port.id || c.to === module.id && c.toPort === port.id)) continue;
      const before = port.anchor ?? (port.side === 'left' ? {x:0,y:port.offset} : port.side === 'right' ? {x:1,y:port.offset}
        : port.side === 'top' ? {x:port.offset,y:0} : {x:port.offset,y:1});
      const horizontal = port.side === 'left' || port.side === 'right', intersections: number[] = [];
      for (let i=0;i<points.length;i++) {
        const a=points[i],b=points[(i+1)%points.length],aa=horizontal?a.y:a.x,bb=horizontal?b.y:b.x;
        const position=horizontal?before.y:before.x;
        if (Math.abs(bb-aa)<1e-6 || position<Math.min(aa,bb)-1e-6 || position>Math.max(aa,bb)+1e-6) continue;
        const t=(position-aa)/(bb-aa);intersections.push(horizontal?a.x+t*(b.x-a.x):a.y+t*(b.y-a.y));
      }
      if (!intersections.length) continue;
      const near = port.side === 'right' || port.side === 'bottom' ? Math.max(...intersections) : Math.min(...intersections);
      const after = horizontal ? {x:near,y:before.y} : {x:before.x,y:near};
      if (Math.hypot((after.x-before.x)*module.width,(after.y-before.y)*module.height)<2) continue;
      port.anchor=after;audit.push({nodeId:module.id,portId:port.id,before,after});
    }
  }
  return {scene,audit};
}
