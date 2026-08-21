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
      <svg viewBox="0 0 24 24" fill="none">
        <rect width="24" height="24" rx="6" fill="#2563EB" />
        <circle cx="12" cy="12" r="2.1" fill="#fff" />
        <path
          d="M12 12 L4.6 5.8 M12 12 L4.6 18.2 M12 12 L19.4 12"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
