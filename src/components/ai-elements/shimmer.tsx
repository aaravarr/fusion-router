"use client";

import { cn } from "@/lib/utils";
import type { ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
}: TextShimmerProps) => {
  return (
    <Component
      className={cn("inline-block animate-pulse text-muted-foreground", className)}
      style={{ animationDuration: `${duration}s` }}
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
