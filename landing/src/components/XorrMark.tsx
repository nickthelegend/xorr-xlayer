/**
 * The xorr mark — four bars around a square gap, and the green dot — traced from
 * assets/brand/xorr-app-icon.png (a 1254px canvas, which is why the coordinates are large).
 */
export function XorrMark({ className, dot = true, title }: { className?: string; dot?: boolean; title?: string }) {
  return (
    <svg
      viewBox={dot ? "240 316 834 606" : "240 316 774 606"}
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <g fill="currentColor">
        <path d="M245 321H379L601 543V602H526Z" />
        <path d="M875 321H1009L726 602H651V543Z" />
        <path d="M526 651H601V709L384 917H254Z" />
        <path d="M651 651H726L984 917H858L651 709Z" />
      </g>
      {dot ? <circle cx="1022" cy="857" r="46" fill="#0DD87E" /> : null}
    </svg>
  );
}
