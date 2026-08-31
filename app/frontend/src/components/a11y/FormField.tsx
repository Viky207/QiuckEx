import React, { useId } from "react";

interface FormFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
}

export default function FormField({
  label,
  value,
  onChange,
  type = "text",
  error,
  required,
  placeholder,
}: FormFieldProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;

  return (
    <div className="form-field">
      <label htmlFor={inputId}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={inputId}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        aria-required={required || undefined}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && (
        <p id={errorId} role="alert" className="form-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
