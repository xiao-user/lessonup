import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({
  className,
  type,
  ...props
}) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-sm border border-input bg-background px-3 text-label-14 text-foreground outline-none transition-[background-color,border-color,box-shadow] duration-[var(--duration-state)] ease-[var(--ease-physical)] file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-button-14 file:text-foreground placeholder:text-muted-foreground hover:border-border-hover focus-visible:border-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-transparent disabled:bg-disabled-background disabled:text-disabled-foreground disabled:opacity-100 aria-invalid:border-destructive",
        className
      )}
      {...props} />
  );
}

export { Input }
