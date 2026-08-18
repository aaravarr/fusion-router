"use client";

import { useMemo, useState } from "react";
import { ChevronDown, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Account } from "./types";

interface AccountPickerProps {
  /** 账号列表（全量）；adminState === "DISABLED" 的账号自动排除。 */
  accounts: Account[];
  /** 当前选中账号 id；空串表示"全部账号"。 */
  value: string;
  /** 选中变化回调；onChange("") 表示切回全部账号。 */
  onChange: (id: string) => void;
}

/** 大小写不敏感的子串过滤：同时匹配账号名（value）与邮箱（keywords）。 */
function accountFilter(value: string, search: string, keywords: string[] = []): number {
  const query = search.trim().toLowerCase();
  if (!query) return 1;
  const haystack = `${value} ${keywords.join(" ")}`.toLowerCase();
  return haystack.includes(query) ? 1 : 0;
}

export function AccountPicker({ accounts, value, onChange }: AccountPickerProps) {
  const [open, setOpen] = useState(false);

  // 排除停用账号并按名称排序（localeCompare，空名称回退到 id）。
  const visibleAccounts = useMemo(
    () =>
      [...accounts]
        .filter((account) => account.adminState !== "DISABLED")
        .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, "zh-CN")),
    [accounts],
  );

  // 触发按钮文案：优先展示已选账号名（可能在列表中被停用过滤掉，故查全量）。
  const selectedAccount = useMemo(() => accounts.find((account) => account.id === value), [accounts, value]);
  const triggerLabel = selectedAccount
    ? selectedAccount.name ?? selectedAccount.id
    : value
      ? value
      : "全部账号";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-label="筛选账号"
          className="w-48 justify-between gap-2 font-normal"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <UsersRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-0">
        <Command filter={accountFilter} className="rounded-lg">
          <CommandInput placeholder="搜索名称或邮箱…" />
          <CommandList className="max-h-[260px] overflow-y-auto">
            <CommandEmpty>无匹配账号</CommandEmpty>
            <CommandGroup className="p-1">
              <CommandItem
                value="全部账号"
                keywords={["all", "全部"]}
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
                data-checked={!value ? "true" : undefined}
              >
                <span className="text-sm">全部账号</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="账号">
              {visibleAccounts.length === 0 ? (
                <CommandItem disabled className="text-sm text-muted-foreground">
                  暂无可用账号
                </CommandItem>
              ) : (
                visibleAccounts.map((account) => (
                  <CommandItem
                    key={account.id}
                    value={account.name ?? account.id}
                    keywords={account.email ? [account.email] : []}
                    onSelect={() => {
                      onChange(account.id);
                      setOpen(false);
                    }}
                    data-checked={value === account.id ? "true" : undefined}
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{account.name ?? account.id}</span>
                      {account.email ? (
                        <span className="truncate text-xs text-muted-foreground">{account.email}</span>
                      ) : null}
                    </div>
                  </CommandItem>
                ))
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
