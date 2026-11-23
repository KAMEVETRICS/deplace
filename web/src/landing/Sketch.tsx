// Ink-line drawings that draw themselves in front of the giant word (our own artwork).
const DRAWINGS: string[][] = [
  // The D stamp.
  ["M14 14h72v72H14z", "M36 30v40h12c12 0 20-8 20-20s-8-20-20-20z"],
  // A badge seal with a check.
  [
    "M50 9l8 7 10-2 4 10 10 4-2 10 7 8-7 8 2 10-10 4-4 10-10-2-8 7-8-7-10 2-4-10-10-4 2-10-7-8 7-8-2-10 10-4 4-10 10 2z",
    "M35 51l10 10 21-23",
  ],
  // A coin.
  ["M50 12a38 38 0 1 0 0.01 0", "M50 22a28 28 0 1 0 0.01 0", "M60 39a13 13 0 1 0 0 22", "M40 47h17", "M40 53h17"],
  // A chain link: what goes on chain.
  ["M20 50a15 15 0 0 1 15-15h17a15 15 0 0 1 0 30h-6", "M80 50a15 15 0 0 1-15 15H48a15 15 0 0 1 0-30h6"],
];

export function Sketch({ index }: { index: number }) {
  const paths = DRAWINGS[index % DRAWINGS.length]!;
  return (
    <svg className="sketch" viewBox="0 0 100 100" fill="none">
      {/* A dark halo under the ink keeps the line readable over the white letters and the dark stage alike. */}
      {paths.map((d) => (
        <path key={`halo-${d}`} className="halo" d={d} pathLength={1} />
      ))}
      {paths.map((d) => (
        <path key={d} d={d} pathLength={1} />
      ))}
    </svg>
  );
}
