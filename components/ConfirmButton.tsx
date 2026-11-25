"use client";
// A button that asks before doing something destructive, inline.
//
// window.confirm() is blocked in many embedded and in-app browsers (it then
// returns false straight away), so "Delete" silently did nothing there.
// This asks in the page instead: the button turns into the question plus
// Cancel / confirm. Focus moves to Cancel, Escape cancels, and nothing runs
// until the second, explicit press.

import { useEffect, useRef, useState, type ReactNode } from "react";

interface ConfirmButtonProps {
  children: ReactNode;
  /** Short question shown while asking, e.g. "Delete this video forever?" */
  question: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  /** Skip the question (e.g. nothing would be lost). */
  skip?: boolean;
  className?: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

export default function ConfirmButton({ children, question, confirmLabel, onConfirm, skip, className, ariaLabel, title, disabled }: ConfirmButtonProps) {
  const [asking, setAsking] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asking) cancelRef.current?.focus();
  }, [asking]);

  const close = () => {
    setAsking(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  if (!asking) {
    return (
      <button ref={triggerRef} type="button" className={className} aria-label={ariaLabel} title={title} disabled={disabled}
        onClick={() => (skip ? void onConfirm() : setAsking(true))}>
        {children}
      </button>
    );
  }
  return (
    <span className="confirm-inline" role="group" aria-label={question}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
      <span className="confirm-inline-q">{question}</span>
      <button ref={cancelRef} type="button" className="confirm-inline-no" onClick={close}>Cancel</button>
      <button type="button" className="confirm-inline-yes" onClick={() => { setAsking(false); void onConfirm(); }}>{confirmLabel}</button>
    </span>
  );
}
