import React from "react";

interface SkipNavLinkProps {
  targetId?: string;
  label?: string;
}

export default function SkipNavLink({
  targetId = "main-content",
  label = "Skip to main content",
}: SkipNavLinkProps) {
  return (
    <a href={`#${targetId}`} className="skip-nav-link">
      {label}
      <style jsx>{`
        .skip-nav-link {
          position: absolute;
          left: -9999px;
          top: 0;
          z-index: 9999;
          padding: 0.75rem 1.25rem;
          background: #1a1a2e;
          color: #ffffff;
          font-weight: 600;
          border-radius: 0 0 8px 0;
        }
        .skip-nav-link:focus {
          left: 0;
        }
      `}</style>
    </a>
  );
}
