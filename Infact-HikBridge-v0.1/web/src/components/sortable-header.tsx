"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import type { SortDirection, SortState } from "@/lib/sorting";

export function SortableHeader<Key extends string>({
  column,
  label,
  sort,
  onSort,
}: {
  column: Key;
  label: string;
  sort: SortState<Key>;
  onSort(column: Key): void;
}) {
  const active = sort.key === column;
  const direction: SortDirection | null = active ? sort.direction : null;
  return (
    <th aria-sort={direction === null ? "none" : direction === "asc" ? "ascending" : "descending"}>
      <button className="sort-button" type="button" onClick={() => onSort(column)}>
        <span>{label}</span>
        {direction === "asc" ? <ArrowUp size={12} aria-hidden /> : direction === "desc" ? <ArrowDown size={12} aria-hidden /> : <ArrowUpDown size={12} aria-hidden />}
      </button>
    </th>
  );
}
