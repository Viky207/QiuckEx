import React from "react";

export type BadgeVariant = "neutral" | "primary" | "success" | "warning" | "danger" | "unverified";

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  /**
   * Optional explanation shown in an accessible tooltip/detail view.
   * When provided, the badge becomes a focusable trigger that reveals the
   * explanation on hover/focus and can be dismissed with Escape.
   */
  description?: string;
  /** Accessible label for the explanation trigger. */
  descriptionLabel?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  primary: "bg-blue-100 text-blue-800",
  success: "bg-green-100 text-green-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  unverified: "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-400",
};

const UnverifiedIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    focusable="false"
    className="mr-1 h-3 w-3"
    viewBox="0 0 16 16"
    fill="currentColor"
  >
    <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 2.25a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V4.5A.75.75 0 0 1 8 3.75Zm0 7.5a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z" />
  </svg>
);

let badgeIdCounter = 0;

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "neutral",
  description,
  descriptionLabel,
}) => {
  const [open, setOpen] = React.useState(false);
  const idRef = React.useRef<string>("");
  if (!idRef.current) {
    badgeIdCounter += 1;
    idRef.current = `badge-description-${badgeIdCounter}`;
  }
  const descriptionId = idRef.current;

  const hasDescription = Boolean(description);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!hasDescription) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((prev) => !prev);
    }
  };

  const content = (
    <>
      {variant === "unverified" && <UnverifiedIcon />}
      <span>{children}</span>
    </>
  );

  const baseClasses = `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${variantStyles[variant]}`;

  if (!hasDescription) {
    return <span className={baseClasses}>{content}</span>;
  }

  return (
    <span className="relative inline-flex">
      <span
        role="button"
        tabIndex={0}
        aria-describedby={open ? descriptionId : undefined}
        aria-label={descriptionLabel}
        aria-expanded={open}
        className={`${baseClasses} cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-blue-500`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        onClick={() => setOpen((prev) => !prev)}
      >
        {content}
      </span>
      {open && (
        <span
          id={descriptionId}
          role="tooltip"
          className="absolute left-0 top-full z-10 mt-1 w-64 rounded-md bg-neutral-900 px-3 py-2 text-xs font-normal text-white shadow-lg"
        >
          {description}
        </span>
      )}
    </span>
  );
};

export default Badge;