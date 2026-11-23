// Line icons in D place's style: 24px grid, 2px square-capped strokes.
const PATHS = {
  board: ["M8 4h11v16H8z", "M5 7h11v16H5z"],
  post: ["M5 5h14v14H5z", "M12 8v8", "M8 12h8"],
  me: ["M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M4 20c1.2-4 4-6 8-6s6.8 2 8 6"],
  wallet: ["M4 8h16v12H4z", "M4 8l2-4h12l2 4", "M14 14h5v3h-5z"],
  back: ["M15 5l-8 7 8 7"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  link: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" aria-hidden>
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
