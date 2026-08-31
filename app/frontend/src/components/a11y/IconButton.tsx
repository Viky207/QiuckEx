import React from "react";

interface IconButtonProps {
  ariaLabel: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}

export default function IconButton({ ariaLabel, onClick, icon, disabled }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className="icon-button"
    >
      {icon}
    </button>
  );
}
