export function LogoMark({
  size = "md",
  className,
}: {
  size?: "md" | "sm";
  className?: string;
}) {
  const cls = size === "sm" ? "logo-mark logo-mark-sm" : "logo-mark";
  return (
    <span className={className ? `${cls} ${className}` : cls} aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none">
        <path d="M32 8.5 L52.4 20.3 L52.4 43.7 L32 55.5 L11.6 43.7 L11.6 20.3 Z" stroke="#2563EB" strokeWidth="6" strokeLinejoin="round" />
        <path d="M32 32 L32 8.5 M32 32 L52.4 43.7 M32 32 L11.6 43.7" stroke="#2563EB" strokeWidth="6" strokeLinecap="round" />
        <circle cx="32" cy="32" r="7" fill="#2563EB" />
        <circle cx="32" cy="8.5" r="4.5" fill="#2563EB" />
        <circle cx="52.4" cy="43.7" r="4.5" fill="#2563EB" />
        <circle cx="11.6" cy="43.7" r="4.5" fill="#2563EB" />
      </svg>
    </span>
  );
}
