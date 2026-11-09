import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
export function Button({
  className,
  asChild,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(
        "inline-flex items-center justify-center rounded-xl border-2 border-[var(--color-ink)] bg-white px-4 py-2 font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-blue)] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
