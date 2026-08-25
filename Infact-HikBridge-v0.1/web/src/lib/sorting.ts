export type SortDirection = "asc" | "desc";
export type SortValue = string | number | boolean | null | undefined;

export interface SortState<Key extends string> {
  key: Key;
  direction: SortDirection;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareValues(left: SortValue, right: SortValue): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return collator.compare(String(left), String(right));
}

export function sortRows<Row, Key extends string>(
  rows: readonly Row[],
  sort: SortState<Key>,
  accessors: Record<Key, (row: Row) => SortValue>,
): Row[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const compared = compareValues(accessors[sort.key](left.row), accessors[sort.key](right.row));
    return compared === 0 ? left.index - right.index : compared * direction;
  }).map(({ row }) => row);
}

export function nextSort<Key extends string>(current: SortState<Key>, key: Key): SortState<Key> {
  return current.key === key ?
    { key, direction: current.direction === "asc" ? "desc" : "asc" } :
    { key, direction: "asc" };
}
