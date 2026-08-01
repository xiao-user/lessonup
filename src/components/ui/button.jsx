import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-button-14 whitespace-nowrap outline-none select-none transition-[background-color,border-color,color,box-shadow] duration-[var(--duration-state)] ease-[var(--ease-state)] disabled:pointer-events-none disabled:bg-disabled-background disabled:text-disabled-foreground disabled:opacity-100 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
        outline:
          "border-border bg-background text-foreground hover:border-border-hover hover:bg-surface-hover active:border-border-active active:bg-surface-active aria-expanded:bg-surface-hover",
        secondary:
          "border-border bg-secondary text-secondary-foreground hover:border-border-hover hover:bg-surface-hover active:border-border-active active:bg-surface-active aria-expanded:bg-surface-hover",
        ghost:
          "bg-transparent text-foreground hover:bg-surface-hover active:bg-surface-active aria-expanded:bg-surface-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-red-900 active:bg-red-700",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-10 gap-2 px-4",
        xs: "h-8 gap-1.5 px-3 text-button-12 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-12 gap-2 px-5 text-button-16",
        icon: "size-10 rounded-full",
        "icon-xs":
          "size-8 rounded-full [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-8 rounded-full",
        "icon-lg": "size-12 rounded-full [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props} />
  );
}

export { Button, buttonVariants }
