// Canvas does not resolve a quoted CSS fallback list as separate font faces.
// Use the primary face for measurements, matching SVG's first available face.
export function canvasFont(family: string, size: number, weight: number|string=400, italic=false) {
  const primary=family.split(',')[0].trim().replace(/^["']|["']$/g,'')||'Arial';
  return `${italic?'italic ':''}${weight} ${size}px "${primary}"`;
}
