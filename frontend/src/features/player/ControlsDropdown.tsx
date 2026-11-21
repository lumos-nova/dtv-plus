import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import styles from "./ControlsDropdown.module.css";

export interface ControlsDropdownOption {
  id: string;
  label: string;
}

export function ControlsDropdown({
  label,
  valueId,
  valueLabel,
  options,
  onSelect,
  onOpenChange,
  openOnHover = true,
  className,
  controlClassName,
  dropdownClassName,
}: {
  label: string;
  valueId: string;
  valueLabel: string;
  options: ControlsDropdownOption[];
  onSelect: (id: string) => void;
  onOpenChange?: (open: boolean) => void;
  openOnHover?: boolean;
  className?: string;
  controlClassName?: string;
  dropdownClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, 220);
  }, [cancelClose]);

  useEffect(() => {
    return () => cancelClose();
  }, [cancelClose]);

  useEffect(() => {
    onOpenChange?.(open);
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onOpenChange, open]);

  if (options.length <= 1) {
    return (
      <span className={styles.staticControl}>
        <span>{valueLabel}</span>
      </span>
    );
  }

  return (
    <div
      className={cn(styles.menuWrap, className)}
      ref={wrapRef}
      onMouseEnter={() => {
        if (!openOnHover) return;
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={() => {
        if (openOnHover) scheduleClose();
      }}
    >
      <button
        type="button"
        className={cn(styles.controlItem, controlClassName, open && styles.menuOpen)}
        onClick={() => setOpen((value) => !value)}
        aria-label={`${label}：${valueLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{valueLabel}</span>
        <ChevronDown size={10} className={cn(styles.caret, open && styles.caretOpen)} />
      </button>
      {open && (
        <div className={cn(styles.dropdown, dropdownClassName)} role="menu" aria-label={label}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === valueId}
              className={cn(
                styles.dropdownItem,
                option.id === valueId && styles.dropdownItemActive,
              )}
              onClick={() => {
                onSelect(option.id);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.id === valueId && <Check size={12} strokeWidth={1.8} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
