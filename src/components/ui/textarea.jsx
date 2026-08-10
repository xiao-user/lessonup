import { cn } from "@/lib/utils";
import { controlFieldClassName } from "@/components/ui/control-field";

function Textarea({ className, ...props }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full px-3 py-2",
        controlFieldClassName,
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
