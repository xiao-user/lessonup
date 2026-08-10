import { cn } from "@/lib/utils";

/**
 * Shared chrome for Input / SelectTrigger / Textarea.
 * Focus matches shadcn: border + soft outer ring flush to the edge
 * (not a hard dual border with a background gap).
 */
export const controlFieldClassName = [
  "rounded-sm border border-input bg-background text-label-14 text-foreground outline-none",
  "transition-[background-color,border-color,box-shadow] duration-[var(--duration-state)] ease-[var(--ease-physical)]",
  "placeholder:text-muted-foreground hover:border-border-hover",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-transparent disabled:bg-disabled-background disabled:text-disabled-foreground disabled:opacity-100 disabled:shadow-none disabled:ring-0",
  "aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-invalid:focus-visible:ring-destructive/20",
].join(" ");
