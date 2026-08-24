import { describe, expect, it } from "vitest";

import { nextSort, sortRows } from "../src/lib/sorting";

const rows = [
  { name: "Employee 10", minutes: 30 },
  { name: "employee 2", minutes: 10 },
  { name: "Employee 1", minutes: 10 },
];

describe("data grid sorting", () => {
  it("sorts text naturally and case-insensitively", () => {
    expect(sortRows(rows, { key: "name", direction: "asc" }, {
      name: (row) => row.name,
    }).map((row) => row.name)).toEqual(["Employee 1", "employee 2", "Employee 10"]);
  });

  it("sorts numbers and preserves input order for ties", () => {
    expect(sortRows(rows, { key: "minutes", direction: "desc" }, {
      minutes: (row) => row.minutes,
    }).map((row) => row.name)).toEqual(["Employee 10", "employee 2", "Employee 1"]);
  });

  it("toggles the active column and resets a new column ascending", () => {
    expect(nextSort({ key: "name", direction: "asc" }, "name")).toEqual({ key: "name", direction: "desc" });
    expect(nextSort({ key: "name", direction: "desc" }, "minutes")).toEqual({ key: "minutes", direction: "asc" });
  });
});
