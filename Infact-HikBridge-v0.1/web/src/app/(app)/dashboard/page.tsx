"use client";

import { AlertTriangle, CalendarDays, ClockAlert, ClockArrowUp, Fingerprint, Timer, UserCheck, UserMinus, Users } from "lucide-react";
import { useCallback } from "react";

import { AttendanceTable } from "@/components/attendance-table";
import { ErrorState, LoadingState, Metric, PageHeader, Panel, StatusBadge, TextLink } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import { formatDate, formatMinutes, relativeTime, todayKey } from "@/lib/format";
import { useAsyncData } from "@/lib/use-async-data";

export default function DashboardPage() {
  const { user } = useAuth();
  const { repository, organization } = useData();
  const date = todayKey(organization?.timezone);
  const load = useCallback(
    () => repository.getDashboard(user?.organizationId ?? "", date),
    [date, repository, user?.organizationId],
  );
  const { data, loading, error } = useAsyncData(load);

  return (
    <>
      <PageHeader eyebrow={formatDate(date, { weekday: "long", day: "2-digit", month: "long", year: "numeric" })} title="Attendance overview" description="A live operational view of today’s workforce, exceptions, and bridge health." />
      {loading ? <Panel><LoadingState label="Calculating today’s overview" /></Panel> : error ? <ErrorState message={error} /> : data ? (
        <>
          <div className="metric-grid">
            <Metric label="Employees" value={data.employeeCount} note="Active workforce" icon={Users} />
            <Metric label="Present today" value={data.presentToday} note={`${Math.round((data.presentToday / Math.max(1, data.employeeCount)) * 100)}% attendance`} tone="positive" icon={UserCheck} />
            <Metric label="Absent today" value={data.absentToday} note="Needs review" tone={data.absentToday > 0 ? "danger" : "neutral"} icon={UserMinus} />
            <Metric label="Late today" value={data.lateToday} note={formatMinutes(data.totalLateMinutes)} tone={data.lateToday > 0 ? "warning" : "neutral"} icon={ClockAlert} />
            <Metric label="On leave" value={data.leaveToday} note="Approved leave" icon={CalendarDays} />
          </div>
          <div className="metric-grid metric-grid-secondary">
            <Metric label="Late time" value={formatMinutes(data.totalLateMinutes, true)} note="Today total" tone="warning" icon={Timer} />
            <Metric label="Overtime" value={formatMinutes(data.totalOvertimeMinutes, true)} note="Qualified today" tone="positive" icon={ClockArrowUp} />
            <Metric label="Missing punches" value={data.missingPunches} note="Open exceptions" tone={data.missingPunches > 0 ? "warning" : "neutral"} icon={AlertTriangle} />
            <Metric label="Devices offline" value={data.devicesOffline} note={`${data.devices.length} configured`} tone={data.devicesOffline > 0 ? "danger" : "neutral"} icon={Fingerprint} />
          </div>

          <div className="content-grid">
            <Panel title="Seven-day workforce pulse" description="Present and absent calculated days" action={<div className="legend"><span><i />Present</span><span><i className="legend-absent" />Absent</span></div>}>
              <div className="trend-chart">{data.trend.map((point) => {
                const scale = Math.max(1, data.employeeCount);
                return <div className="trend-day" key={point.date}><div className="trend-bars"><span className="trend-bar" style={{ height: `${Math.max(3, point.present / scale * 120)}px` }} title={`${point.present} present`} /><span className="trend-bar trend-bar-absent" style={{ height: `${Math.max(3, point.absent / scale * 120)}px` }} title={`${point.absent} absent`} /></div><small>{formatDate(point.date, { weekday: "short" })}</small></div>;
              })}</div>
            </Panel>
            <Panel title="Exceptions requiring attention" description={`${data.missingPunches + data.devicesOffline + data.unmappedEvents} signals today`} action={<TextLink href="/attendance">Review</TextLink>}>
              <div className="exception-list">
                <div className="exception-item"><div><span className="exception-icon"><AlertTriangle size={15} /></span><span><strong>Missing punches</strong><small>Incomplete workday evidence</small></span></div><strong>{data.missingPunches}</strong></div>
                <div className="exception-item"><div><span className="exception-icon"><Fingerprint size={15} /></span><span><strong>Unmapped device events</strong><small>Need employee identity</small></span></div><strong>{data.unmappedEvents}</strong></div>
                <div className="exception-item"><div><span className="exception-icon"><ClockAlert size={15} /></span><span><strong>Late arrivals</strong><small>{formatMinutes(data.totalLateMinutes)} total</small></span></div><strong>{data.lateToday}</strong></div>
              </div>
            </Panel>
          </div>

          <div className="content-grid dashboard-lower-grid">
            <Panel title="Today’s attendance" description="Latest calculated rows" action={<TextLink href="/attendance">All attendance</TextLink>}>
              <AttendanceTable days={data.attendance.slice(0, 6)} />
            </Panel>
            <Panel title="Bridge health" description="Latest cloud heartbeat" action={<TextLink href="/devices">All devices</TextLink>}>
              <div className="device-mini-list">{data.devices.slice(0, 4).map((device) => <div className="device-mini" key={device.id}><div><span className="device-state-dot" data-status={device.connectionStatus} /><span><strong>{device.name}</strong><small>{device.model} · {relativeTime(device.lastSeenAt)}</small></span></div><StatusBadge status={device.connectionStatus} /></div>)}</div>
            </Panel>
          </div>
        </>
      ) : null}
    </>
  );
}
