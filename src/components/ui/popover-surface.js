import { cn } from "@/lib/utils";

/** Shared surface for Select / DropdownMenu popovers. */
export function popoverSurfaceClassName(className) {
  return cn(
    "z-50 min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-popover outline-none duration-[var(--duration-popover)] ease-[var(--ease-state)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
    className,
  );
}

/** Shared row chrome for SelectItem / DropdownMenuItem. */
export function popoverItemClassName(className) {
  return cn(
    "relative flex min-h-8 w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-label-14 outline-hidden select-none data-highlighted:bg-surface-hover data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:text-disabled-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    className,
  );
}
