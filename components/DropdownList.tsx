"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A select-style menu following the WAI-ARIA listbox pattern: a button opens a
 * list of options; arrow keys / Home / End move, Enter or Space picks, Escape
 * closes and returns focus to the button, and clicking elsewhere closes it.
 */
const DropdownList = ({
  options,
  selectedOption,
  onOptionSelect,
  triggerElement,
  ariaLabel,
}: DropdownListProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const open = () => {
    setActiveIndex(Math.max(0, options.indexOf(selectedOption)));
    setIsOpen(true);
  };
  const close = (returnFocus = true) => {
    setIsOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Move focus into the list so its key handling receives the arrow keys.
  useEffect(() => {
    if (isOpen) listRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen]);

  const select = (option: string) => {
    onOptionSelect(option);
    close();
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + options.length) % options.length);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        select(options[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? baseId : undefined}
        aria-label={ariaLabel ? `${ariaLabel}: ${selectedOption}` : undefined}
        onClick={() => (isOpen ? close(false) : open())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            open();
          }
        }}
      >
        {triggerElement}
      </button>

      {isOpen && (
        <ul
          ref={listRef}
          id={baseId}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={optionId(activeIndex)}
          className="dropdown"
          onKeyDown={onListKeyDown}
        >
          {options.map((option, i) => (
            <li
              key={option}
              id={optionId(i)}
              role="option"
              aria-selected={selectedOption === option}
              className={cn("list-item", {
                "is-selected": selectedOption === option,
                "is-active": activeIndex === i,
              })}
              onClick={() => select(option)}
              onMouseMove={() => activeIndex !== i && setActiveIndex(i)}
            >
              {option}
              {selectedOption === option && (
                <Image src="/assets/icons/check.svg" alt="" aria-hidden width={16} height={16} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default DropdownList;
