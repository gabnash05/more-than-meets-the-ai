"use client";
import * as React from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;
export function DropdownMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof Dropdown.Content>) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content
        className={cn(
          "z-50 min-w-40 rounded-xl border-2 border-[var(--color-ink)] bg-white p-1",
          className,
        )}
        {...props}
      />
    </Dropdown.Portal>
  );
}
export function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof Dropdown.Item>) {
  return (
    <Dropdown.Item
      className={cn(
        "cursor-pointer rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-[var(--color-yellow)]",
        className,
      )}
      {...props}
    />
  );
}
