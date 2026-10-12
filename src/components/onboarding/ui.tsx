import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, Globe2, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { formatHotkeyLabel, isGlobeLikeHotkey } from "../../utils/hotkeys";

/* ------------------------------------------------------------------------ */
/* Buttons                                                                   */
/* ------------------------------------------------------------------------ */

type OnbButtonVariant = "primary" | "secondary" | "ghost" | "accent";
type OnbButtonSize = "sm" | "md" | "lg";

interface OnbButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: OnbButtonVariant;
  size?: OnbButtonSize;
}

const BUTTON_VARIANTS: Record<OnbButtonVariant, string> = {
  primary: "bg-[var(--onb-ink)] text-[var(--onb-bg)] hover:opacity-85",
  secondary:
    "border border-[var(--onb-card-border)] bg-[var(--onb-card)] text-[var(--onb-ink)] hover:bg-[var(--onb-panel)]",
  ghost: "text-[var(--onb-ink-muted)] hover:bg-[var(--onb-panel)] hover:text-[var(--onb-ink)]",
  accent: "bg-[var(--onb-accent)] text-[var(--onb-accent-foreground)] hover:opacity-85",
};

const BUTTON_SIZES: Record<OnbButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-9 px-4 text-sm",
  lg: "h-10 px-6 text-sm",
};

export function OnbButton({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: OnbButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium leading-5 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--onb-bg)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------------ */
/* Layout                                                                    */
/* ------------------------------------------------------------------------ */

interface StepFrameProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  width?: "md" | "lg" | "xl";
}

const FRAME_WIDTHS = { md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-3xl" };

export function StepFrame({
  title,
  description,
  children,
  className,
  width = "lg",
}: StepFrameProps) {
  return (
    <div
      className={cn(
        "onboarding-stagger mx-auto flex w-full flex-col items-center text-center",
        FRAME_WIDTHS[width],
        className
      )}
    >
      <h1 className="text-2xl font-semibold leading-tight tracking-tight text-[var(--onb-ink)]">
        {title}
      </h1>
      {description && (
        <p className="mt-2.5 max-w-xl text-sm leading-6 text-[var(--onb-ink-muted)]">
          {description}
        </p>
      )}
      {children && <div className="mt-6 flex w-full flex-col items-center">{children}</div>}
    </div>
  );
}

export function Accent({ children }: { children: ReactNode }) {
  return <span className="text-[var(--onb-accent)]">{children}</span>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "w-full rounded-xl border border-[var(--onb-card-border)] bg-[var(--onb-card)] shadow-[0_2px_8px_rgba(0,0,0,0.04)] dark:shadow-none",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl bg-[var(--onb-panel)]", className)}>{children}</div>;
}

/* ------------------------------------------------------------------------ */
/* Keycaps                                                                   */
/* ------------------------------------------------------------------------ */

type KeycapSize = "inline" | "md" | "lg" | "xl";

interface KeycapProps {
  hotkey: string;
  size?: KeycapSize;
  /** The key is physically held right now. */
  pressed?: boolean;
  /** The key has been verified; keeps the accent colour after release. */
  active?: boolean;
  /** Loops a gentle press animation (used on instructional screens). */
  demo?: boolean;
  className?: string;
}

const KEYCAP_SIZES: Record<KeycapSize, { box: string; text: string; fn: string; globe: string }> = {
  inline: {
    box: "h-7 min-w-7 px-1.5 rounded-md",
    text: "text-sm",
    fn: "text-2xs",
    globe: "h-3 w-3",
  },
  md: { box: "h-12 min-w-12 px-3 rounded-lg", text: "text-base", fn: "text-xs", globe: "h-4 w-4" },
  lg: { box: "h-20 min-w-20 px-5 rounded-xl", text: "text-2xl", fn: "text-sm", globe: "h-5 w-5" },
  xl: {
    box: "h-28 min-w-28 px-6 rounded-2xl",
    text: "text-3xl",
    fn: "text-base",
    globe: "h-7 w-7",
  },
};

function keycapClasses(size: KeycapSize, state: "idle" | "pressed" | "active", demo?: boolean) {
  const dims = KEYCAP_SIZES[size];
  return cn(
    "relative inline-flex select-none items-center justify-center border font-sans font-semibold transition-all duration-150",
    dims.box,
    dims.text,
    state === "idle" &&
      "border-[var(--onb-key-border)] bg-[var(--onb-key)] text-[var(--onb-ink)] shadow-[var(--onb-key-shadow)]",
    state === "pressed" &&
      "translate-y-[2px] border-[var(--onb-accent)] bg-[var(--onb-accent)] text-[var(--onb-accent-foreground)] shadow-none",
    state === "active" &&
      "border-[var(--onb-accent)] bg-[var(--onb-accent)] text-[var(--onb-accent-foreground)] shadow-[var(--onb-key-shadow)]",
    demo && "animate-[onboarding-key-press_2200ms_ease-in-out_infinite]"
  );
}

export function Keycap({ hotkey, size = "md", pressed, active, demo, className }: KeycapProps) {
  const state = pressed ? "pressed" : active ? "active" : "idle";
  const dims = KEYCAP_SIZES[size];

  if (isGlobeLikeHotkey(hotkey) && size === "inline") {
    return (
      <kbd
        className={cn(keycapClasses(size, state, demo), "gap-1 px-2", className)}
        aria-label="fn / Globe"
      >
        <Globe2 className="h-3 w-3" strokeWidth={1.8} aria-hidden="true" />
        <span className="text-xs font-semibold leading-none">fn</span>
      </kbd>
    );
  }

  if (isGlobeLikeHotkey(hotkey)) {
    const square = size === "md" ? "w-12" : size === "lg" ? "w-20" : "w-28";
    return (
      <kbd
        className={cn(keycapClasses(size, state, demo), square, "px-0", className)}
        aria-label="fn / Globe"
      >
        <span className={cn("absolute right-[18%] top-[12%] font-semibold leading-none", dims.fn)}>
          fn
        </span>
        <Globe2
          className={cn("absolute bottom-[14%] left-[16%]", dims.globe)}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </kbd>
    );
  }

  const parts = formatHotkeyLabel(hotkey)
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex items-center gap-1.5">
          {index > 0 && <span className="text-[var(--onb-ink-muted)]">+</span>}
          <kbd className={keycapClasses(size, state, demo)}>{part}</kbd>
        </span>
      ))}
    </span>
  );
}

/** Token used inside translated strings where an inline keycap belongs. */
export const KEY_TOKEN = "⟪KEY⟫";

interface ShortcutSentenceProps {
  text: string;
  hotkey: string;
  className?: string;
}

/** Renders a sentence that contains KEY_TOKEN with an inline keycap in its place. */
export function ShortcutSentence({ text, hotkey, className }: ShortcutSentenceProps) {
  const parts = text.split(KEY_TOKEN);
  return (
    <span className={className}>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && <Keycap hotkey={hotkey} size="inline" className="mx-1 align-middle" />}
          {part}
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------------ */
/* Choice grid                                                               */
/* ------------------------------------------------------------------------ */

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  emoji?: string;
}

interface ChoiceGridProps {
  options: ChoiceOption[];
  value: string | string[];
  onChange: (next: string | string[]) => void;
  multi?: boolean;
  columns?: 2 | 3 | 4;
  className?: string;
  compact?: boolean;
}

const GRID_COLUMNS = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" };

export function ChoiceGrid({
  options,
  value,
  onChange,
  multi = false,
  columns = 3,
  className,
  compact = false,
}: ChoiceGridProps) {
  const selectedIds = new Set(Array.isArray(value) ? value : value ? [value] : []);

  const toggle = (id: string) => {
    if (!multi) {
      onChange(id);
      return;
    }
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  return (
    <div
      className={cn("onboarding-stagger grid w-full gap-3", GRID_COLUMNS[columns], className)}
      role={multi ? "group" : "radiogroup"}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const selected = selectedIds.has(option.id);
        return (
          <button
            key={option.id}
            type="button"
            role={multi ? undefined : "radio"}
            aria-checked={multi ? undefined : selected}
            aria-pressed={multi ? selected : undefined}
            onClick={() => toggle(option.id)}
            className={cn(
              "group relative flex flex-col items-start gap-2 rounded-lg border bg-[var(--onb-card)] text-left transition-all duration-150 hover:bg-[var(--onb-panel)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)]",
              compact ? "px-3.5 py-2.5" : "min-h-20 px-4 py-3.5",
              selected
                ? "border-[var(--onb-accent)] bg-[var(--onb-accent-soft)] hover:bg-[var(--onb-accent-soft)]"
                : "border-[var(--onb-card-border)]"
            )}
          >
            {(Icon || option.emoji) && (
              <span
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-md text-base",
                  selected
                    ? "bg-[var(--onb-accent)] text-[var(--onb-accent-foreground)]"
                    : "bg-[var(--onb-panel)] text-[var(--onb-ink-muted)]"
                )}
                aria-hidden="true"
              >
                {Icon ? <Icon className="h-4 w-4" strokeWidth={1.8} /> : option.emoji}
              </span>
            )}
            <span className="text-sm font-semibold leading-5 text-[var(--onb-ink)]">
              {option.label}
            </span>
            {option.description && (
              <span className="text-xs leading-4 text-[var(--onb-ink-muted)]">
                {option.description}
              </span>
            )}
            <span
              className={cn(
                "absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border transition-all duration-150",
                selected
                  ? "scale-100 border-[var(--onb-accent)] bg-[var(--onb-accent)] text-[var(--onb-accent-foreground)]"
                  : "scale-75 border-[var(--onb-card-border)] opacity-0 group-hover:opacity-100"
              )}
              aria-hidden="true"
            >
              {selected && <Check className="h-3 w-3" strokeWidth={3} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Switch                                                                    */
/* ------------------------------------------------------------------------ */

interface OnbSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

export function OnbSwitch({ checked, onChange, label }: OnbSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)]",
        checked
          ? "border-[var(--onb-accent)] bg-[var(--onb-accent)]"
          : "border-[var(--onb-card-border)] bg-[var(--onb-panel)]"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5.5 w-5.5 rounded-full bg-white shadow-sm transition-[left] duration-200",
          checked ? "left-[calc(100%-1.5rem)]" : "left-0.5"
        )}
        style={{ height: "1.375rem", width: "1.375rem" }}
      />
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* Celebration                                                               */
/* ------------------------------------------------------------------------ */

const CELEBRATION_PIECES = Array.from({ length: 18 }, (_, index) => {
  const angle = (index / 18) * Math.PI * 2;
  const distance = 90 + (index % 4) * 28;
  return {
    dx: `${Math.round(Math.cos(angle) * distance)}px`,
    dy: `${Math.round(Math.sin(angle) * distance)}px`,
    rot: `${(index % 2 ? 1 : -1) * (120 + index * 11)}deg`,
    delay: `${(index % 6) * 40}ms`,
    color: index % 3 === 0 ? "var(--onb-accent)" : index % 3 === 1 ? "#4b6fff" : "#f5c242",
  };
});

/** A one-shot burst of confetti-like sparks, centred on its parent. */
export function Celebration({ className }: { className?: string }) {
  return (
    <span
      className={cn("pointer-events-none absolute left-1/2 top-1/2 h-0 w-0", className)}
      aria-hidden="true"
    >
      {CELEBRATION_PIECES.map((piece, index) => (
        <span
          key={index}
          className="absolute h-2.5 w-2.5 rounded-sm animate-[onboarding-celebrate_1100ms_cubic-bezier(0.22,1,0.36,1)_both]"
          style={
            {
              "--dx": piece.dx,
              "--dy": piece.dy,
              "--rot": piece.rot,
              animationDelay: piece.delay,
              backgroundColor: piece.color,
              marginLeft: "-5px",
              marginTop: "-5px",
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
