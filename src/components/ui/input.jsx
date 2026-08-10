import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"
import { controlFieldClassName } from "@/components/ui/control-field"

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
        "h-10 w-full min-w-0 px-3",
        controlFieldClassName,
        "file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-button-14 file:text-foreground",
        className
      )}
      {...props} />
  );
}

export { Input }
