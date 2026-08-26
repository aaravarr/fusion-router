"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface FilterMultiSelectOption {
  value: string;
  label: string;
}

interface FilterMultiSelectProps {
  /** 维度名（触发按钮与搜索占位符共用）。 */
  label: string;
  options: FilterMultiSelectOption[];
  /** 已选值集合；空数组表示该维度不筛选。 */
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}

/** 多选筛选下拉：Command 列表 + 复选指示，选中数显示在触发按钮上（对齐 AccountPicker 交互）。 */
export function FilterMultiSelect({ label, options, selected, onChange, className }: FilterMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const selectedSet = new Set(selected);

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  const triggerLabel = selected.length > 0 ? `${label} · ${selected.length}` : label;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-label={`筛选${label}`}
          className={cn(
            "w-full justify-between gap-1.5 font-normal sm:w-auto",
            selected.length > 0 &&
              "border-primary bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            className,
          )}
        >
          <span className="max-w-44 truncate">{triggerLabel}</span>
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-64 p-0">
        <Command className="rounded-lg">
          {options.length > 8 ? <CommandInput placeholder={`搜索${label}…`} /> : null}
          <CommandList className="max-h-[260px] overflow-y-auto">
            <CommandEmpty>无匹配项</CommandEmpty>
            <CommandGroup className="p-1">
              {options.length === 0 ? (
                <CommandItem disabled className="text-sm text-muted-foreground">
                  暂无可选项
                </CommandItem>
              ) : (
                options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    onSelect={() => toggle(option.value)}
                    data-checked={selectedSet.has(option.value) ? "true" : undefined}
                  >
                    <Check
                      className={cn("size-3.5 shrink-0", selectedSet.has(option.value) ? "opacity-100" : "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="truncate text-sm">{option.label}</span>
                  </CommandItem>
                ))
              )}
            </CommandGroup>
          </CommandList>
          {selected.length > 0 ? (
            <div className="border-t p-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="w-full text-muted-foreground"
                onClick={() => onChange([])}
              >
                清除已选（{selected.length}）
              </Button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}