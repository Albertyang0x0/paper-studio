const sub: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};
// Typographic conversion only; never evaluates or invents mathematical content.
// Complex LaTeX remains literal rather than pretending to support a full parser.
export function displayMath(text: string) {
  return text
    .replace(/\$([^$]+)\$/g, "$1")
    .replace(
      /([A-Za-z])_(?:\{([^}]+)\}|([A-Za-z0-9]))/g,
      (whole, base, braced, single) => {
        const index = String(braced ?? single);
        return Array.from(index).every((c) => sub[c])
          ? base + Array.from(index, (c) => sub[c]).join("")
          : whole;
      },
    );
}
