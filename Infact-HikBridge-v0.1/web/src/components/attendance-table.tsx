"use client";

import { CircleDot, PencilLine } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { SortableHeader } from "@/components/sortable-header";
import type { AttendanceDay } from "@/lib/data/types";
import { attendanceDisplayStatus } from "@/lib/data/attendance-status";
import { formatDate, formatMinutes, initials } from "@/lib/format";
import { nextSort, sortRows, type SortState } from "@/lib/sorting";
import { EmptyState, StatusBadge } from "./ui";

type AttendanceSort = "date" | "employee" | "scheduled" | "firstIn" | "lastOut" | "worked" | "late" | "earlyLeave" | "overtime" | "status";

export function AttendanceTable({ days, showEmployee = true, onCorrect }: {
  days: AttendanceDay[];
  showEmployee?: boolean;
  onCorrect?: (day: AttendanceDay) => void;
}) {
  const [sort, setSort] = useState<SortState<AttendanceSort>>({ key: "date", direction: "desc" });
  const rows = useMemo(() => sortRows(days, sort, {
    date: (day) => day.date,
    employee: (day) => day.employeeName,
    scheduled: (day) => day.scheduledIn,
    firstIn: (day) => day.firstIn,
    lastOut: (day) => day.lastOut,
    worked: (day) => day.workedMinutes,
    late: (day) => day.lateMinutes,
    earlyLeave: (day) => day.earlyLeaveMinutes,
    overtime: (day) => day.overtimeMinutes,
    status: (day) => attendanceDisplayStatus(day),
  }), [days, sort]);
  const requestSort = (key: AttendanceSort) => setSort((current) => nextSort(current, key));
  if (days.length === 0) return <EmptyState title="No attendance rows" message="No calculated attendance matches the selected date and filters." />;
  return (
    <div className="table-wrap">
      <table className="data-table responsive-table">
        <thead><tr>
          <SortableHeader column="date" label="Date" sort={sort} onSort={requestSort} />
          {showEmployee ? <SortableHeader column="employee" label="Employee" sort={sort} onSort={requestSort} /> : null}
          <SortableHeader column="scheduled" label="Scheduled" sort={sort} onSort={requestSort} />
          <SortableHeader column="firstIn" label="First in" sort={sort} onSort={requestSort} />
          <SortableHeader column="lastOut" label="Last out" sort={sort} onSort={requestSort} />
          <SortableHeader column="worked" label="Worked" sort={sort} onSort={requestSort} />
          <SortableHeader column="late" label="Late" sort={sort} onSort={requestSort} />
          <SortableHeader column="earlyLeave" label="Early leave" sort={sort} onSort={requestSort} />
          <SortableHeader column="overtime" label="OT" sort={sort} onSort={requestSort} />
          <SortableHeader column="status" label="Status" sort={sort} onSort={requestSort} />
          {onCorrect ? <th aria-label="Actions" /> : null}
        </tr></thead>
        <tbody>{rows.map((day) => (
          <tr key={day.id}>
            <td data-label="Date" data-primary={!showEmployee || undefined}><span className="numeric">{formatDate(day.date, { day: "2-digit", month: "short" })}</span>{day.hasManualAdjustment ? <span className="adjusted-mark" title="Contains a manual adjustment"><CircleDot size={11} />Adjusted</span> : null}</td>
            {showEmployee ? <td data-label="Employee" data-primary="true"><Link href={`/employees/${day.employeeId}`} className="cell-main"><span className="cell-avatar">{initials(day.employeeName)}</span><span className="cell-copy"><strong>{day.employeeName}</strong><small>{day.employeeCode} · {day.departmentName}</small></span></Link></td> : null}
            <td data-label="Scheduled" className="numeric muted">{day.scheduledIn && day.scheduledOut ? `${day.scheduledIn}–${day.scheduledOut}` : "—"}</td>
            <td data-label="First in" className="numeric">{day.firstIn ?? "—"}</td>
            <td data-label="Last out" className="numeric">{day.lastOut ?? "—"}</td>
            <td data-label="Worked" className="numeric">{formatMinutes(day.workedMinutes, true)}</td>
            <td data-label="Late" className={day.lateMinutes > 0 ? "numeric warning-text" : "numeric muted"}>{formatMinutes(day.lateMinutes, true)}</td>
            <td data-label="Early leave" className={day.earlyLeaveMinutes > 0 ? "numeric warning-text" : "numeric muted"}>{formatMinutes(day.earlyLeaveMinutes, true)}</td>
            <td data-label="Overtime" className={day.overtimeMinutes > 0 ? "numeric positive-text" : "numeric muted"}>{formatMinutes(day.overtimeMinutes, true)}</td>
            <td data-label="Status"><StatusBadge status={attendanceDisplayStatus(day)} /></td>
            {onCorrect ? <td data-action="true"><button className="icon-button table-action" onClick={() => onCorrect(day)} aria-label={`Correct ${day.employeeName} attendance`}><PencilLine size={14} /></button></td> : null}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
