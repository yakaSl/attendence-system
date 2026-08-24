import { CircleDot, PencilLine } from "lucide-react";
import Link from "next/link";

import type { AttendanceDay } from "@/lib/data/types";
import { formatDate, formatMinutes, initials } from "@/lib/format";
import { EmptyState, StatusBadge } from "./ui";

export function AttendanceTable({ days, showEmployee = true, onCorrect }: {
  days: AttendanceDay[];
  showEmployee?: boolean;
  onCorrect?: (day: AttendanceDay) => void;
}) {
  if (days.length === 0) return <EmptyState title="No attendance rows" message="No calculated attendance matches the selected date and filters." />;
  return (
    <div className="table-wrap">
      <table className="data-table responsive-table">
        <thead><tr>
          <th>Date</th>
          {showEmployee ? <th>Employee</th> : null}
          <th>Scheduled</th><th>First in</th><th>Last out</th><th>Worked</th><th>Late</th><th>Early leave</th><th>OT</th><th>Status</th>
          {onCorrect ? <th aria-label="Actions" /> : null}
        </tr></thead>
        <tbody>{days.map((day) => (
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
            <td data-label="Status"><StatusBadge status={day.exceptions.some((value) => value.startsWith("missing_")) ? "missing_punch" : day.status} /></td>
            {onCorrect ? <td data-action="true"><button className="icon-button table-action" onClick={() => onCorrect(day)} aria-label={`Correct ${day.employeeName} attendance`}><PencilLine size={14} /></button></td> : null}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
