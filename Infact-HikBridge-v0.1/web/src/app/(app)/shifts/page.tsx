"use client";

import { AlertTriangle, CalendarPlus, Check, Clock3, Moon, PencilLine, UserPlus, X } from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";

import { SortableHeader } from "@/components/sortable-header";
import { Button, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Panel, RoleGate, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth/auth-provider";
import { useData } from "@/lib/data/data-provider";
import type { Employee, Shift, ShiftInference } from "@/lib/data/types";
import { assignEmployeeShift, resolveShiftInference, saveShift } from "@/lib/firebase/actions";
import { formatDate, formatMinutes, todayKey } from "@/lib/format";
import { nextSort, sortRows, type SortState } from "@/lib/sorting";
import { useAsyncData } from "@/lib/use-async-data";

interface ShiftData { shifts: Shift[]; employees: Employee[]; inferences: ShiftInference[] }
type ReviewSort = "date" | "employee" | "punch" | "shift" | "confidence";
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function ShiftsPage() {
  const { user } = useAuth();
  const { repository, organization } = useData();
  const date = todayKey(organization?.timezone);
  const canManage = user !== null && ["organizationOwner", "hrAdmin", "platformAdmin"].includes(user.role);
  const load = useCallback(async (): Promise<ShiftData> => {
    const organizationId = user?.organizationId ?? "";
    const [shifts, employees, inferences] = await Promise.all([
      repository.getShifts(organizationId),
      repository.getEmployees(organizationId, date),
      canManage ? repository.getShiftInferences(organizationId) : Promise.resolve([]),
    ]);
    return { shifts, employees, inferences };
  }, [canManage, date, repository, user?.organizationId]);
  const { data, loading, error, refresh } = useAsyncData(load);
  const [editing, setEditing] = useState<Shift | "new" | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [reviewing, setReviewing] = useState<ShiftInference | null>(null);
  const [reviewSort, setReviewSort] = useState<SortState<ReviewSort>>({ key: "date", direction: "desc" });
  const reviewRows = useMemo(() => sortRows(data?.inferences ?? [], reviewSort, {
    date: (inference) => inference.date,
    employee: (inference) => inference.employeeName,
    punch: (inference) => inference.firstPunchAt,
    shift: (inference) => inference.suggestedShiftId,
    confidence: (inference) => inference.confidence,
  }), [data?.inferences, reviewSort]);

  return (
    <>
      <PageHeader eyebrow="Work schedules" title="Shifts" description="Define attendance policy once, including overnight boundaries, then assign it over explicit historical date ranges." actions={canManage ? <><Button variant="secondary" onClick={() => setAssigning(true)}><UserPlus size={14} />Assign shift</Button><Button onClick={() => setEditing("new")}><CalendarPlus size={14} />New shift</Button></> : undefined} />
      <div className="policy-note"><Clock3 size={16} /><span><strong>Historical behavior is preserved by date-ranged assignments.</strong> Editing a shift creates an audit record and queues controlled recalculation from the selected date.</span></div>
      {canManage ? <Panel title="Shift review" description={`${reviewRows.length} ambiguous punch match${reviewRows.length === 1 ? "" : "es"} waiting for HR`}>
        {loading ? <LoadingState label="Loading shift suggestions" /> : error ? <ErrorState message={error} /> : reviewRows.length === 0 ? <EmptyState title="No shift decisions needed" message="Clear matches are applied only to their attendance day. Ambiguous punches will appear here." /> : <div className="table-wrap"><table className="data-table responsive-table"><thead><tr>
          <SortableHeader column="date" label="Date" sort={reviewSort} onSort={(key) => setReviewSort((current) => nextSort(current, key))} />
          <SortableHeader column="employee" label="Employee" sort={reviewSort} onSort={(key) => setReviewSort((current) => nextSort(current, key))} />
          <SortableHeader column="punch" label="First punch" sort={reviewSort} onSort={(key) => setReviewSort((current) => nextSort(current, key))} />
          <SortableHeader column="shift" label="Suggested shift" sort={reviewSort} onSort={(key) => setReviewSort((current) => nextSort(current, key))} />
          <SortableHeader column="confidence" label="Confidence" sort={reviewSort} onSort={(key) => setReviewSort((current) => nextSort(current, key))} />
          <th aria-label="Review" />
        </tr></thead><tbody>{reviewRows.map((inference) => {
          const shift = data?.shifts.find((candidate) => candidate.id === inference.suggestedShiftId);
          return <tr key={inference.id}>
            <td data-label="Date" className="numeric">{formatDate(inference.date)}</td>
            <td data-label="Employee" data-primary="true"><span className="cell-copy"><strong>{inference.employeeName}</strong><small>{inference.employeeCode}</small></span></td>
            <td data-label="First punch" className="numeric">{formatPunchTime(inference.firstPunchAt, organization?.timezone)}</td>
            <td data-label="Suggested shift"><span className="cell-copy"><strong>{shift?.name ?? inference.suggestedShiftId ?? "No clear match"}</strong><small>{shift ? `${shift.startTime}–${shift.endTime}` : "Review candidates"}</small></span></td>
            <td data-label="Confidence"><span className="confidence-badge" data-confidence={inference.confidence}>{inference.confidence}</span></td>
            <td data-action="true"><Button variant="secondary" onClick={() => setReviewing(inference)}>Review</Button></td>
          </tr>;
        })}</tbody></table></div>}
      </Panel> : null}
      <Panel title="Shift policies" description={`${data?.shifts.length ?? 0} configured schedules`}>
        {loading ? <LoadingState label="Loading shifts" /> : error ? <ErrorState message={error} /> : !data || data.shifts.length === 0 ? <EmptyState title="No shifts configured" message="Create the first work schedule before assigning employees." /> : (
          <div className="shift-list">{data.shifts.map((shift) => {
            const overnight = shift.endTime <= shift.startTime;
            return <article className="shift-row" key={shift.id}>
              <div className="shift-title"><span className="shift-icon">{overnight ? <Moon size={17} /> : <Clock3 size={17} />}</span><div><strong>{shift.name}</strong><small>{shift.id} · {overnight ? "Overnight shift" : "Same-day shift"}</small></div></div>
              <div className="shift-time"><strong>{shift.startTime}<span>→</span>{shift.endTime}</strong><small>{formatMinutes(shift.breakMinutes)} break</small></div>
              <div className="shift-policy"><small>Grace / late rule</small><strong>{shift.gracePeriodMinutes} min · {shift.lateCalculationMode === "after_grace" ? "after grace" : "from start"}</strong></div>
              <div className="shift-policy"><small>Overtime</small><strong>{shift.overtimeEnabled ? `${shift.overtimeMinimumMinutes} min min · ${shift.overtimeRoundingMinutes} min ${shift.overtimeRoundingMode}` : "Disabled"}</strong></div>
              <div className="weekday-dots">{weekdays.map((day, index) => <span key={day} data-active={shift.workingDays.includes(index + 1)}>{day[0]}</span>)}</div>
              <StatusBadge status={shift.active ? "online" : "disabled"} />
              {canManage ? <button className="icon-button" onClick={() => setEditing(shift)} aria-label={`Edit ${shift.name}`}><PencilLine size={14} /></button> : null}
            </article>;
          })}</div>
        )}
      </Panel>
      <RoleGate role={user?.role ?? "viewer"} allowed={["organizationOwner", "hrAdmin"]}>
        <ShiftModal shift={editing} organizationId={user?.organizationId ?? ""} today={date} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
        <AssignmentModal open={assigning} shifts={data?.shifts ?? []} employees={data?.employees ?? []} organizationId={user?.organizationId ?? ""} today={date} onClose={() => setAssigning(false)} onSaved={() => { setAssigning(false); refresh(); }} />
        <ShiftReviewModal key={reviewing?.id ?? "closed"} inference={reviewing} shifts={data?.shifts ?? []} organizationId={user?.organizationId ?? ""} timezone={organization?.timezone ?? "Asia/Colombo"} onClose={() => setReviewing(null)} onResolved={() => { setReviewing(null); refresh(); }} />
      </RoleGate>
    </>
  );
}

function formatPunchTime(value: string | null, timezone = "Asia/Colombo"): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date(value));
}

function ShiftReviewModal({ inference, shifts, organizationId, timezone, onClose, onResolved }: {
  inference: ShiftInference | null;
  shifts: Shift[];
  organizationId: string;
  timezone: string;
  onClose(): void;
  onResolved(): void;
}) {
  const [shiftId, setShiftId] = useState(inference?.suggestedShiftId ?? "");
  const [reason, setReason] = useState("Confirmed from employee punch evidence");
  const [submitting, setSubmitting] = useState<"confirm" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(decision: "confirm" | "reject") {
    if (inference === null) return;
    setSubmitting(decision);
    setError(null);
    try {
      await resolveShiftInference({
        organizationId,
        inferenceId: inference.id,
        decision,
        shiftId: decision === "confirm" ? shiftId || null : null,
        reason,
      });
      onResolved();
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "Shift suggestion could not be resolved");
    } finally {
      setSubmitting(null);
    }
  }

  return <Modal open={inference !== null} title="Review shift match" description={inference ? `${inference.employeeCode} · ${inference.employeeName} · ${formatDate(inference.date)}` : ""} onClose={onClose}>
    {inference ? <form className="modal-content" onSubmit={(event) => { event.preventDefault(); void resolve("confirm"); }}>
      {error ? <ErrorState message={error} /> : null}
      <div className="inference-evidence"><AlertTriangle size={18} /><div><strong>{inference.explanation}</strong><small>First punch {formatPunchTime(inference.firstPunchAt, timezone)} · {inference.confidence} confidence</small></div></div>
      <div className="candidate-list">{inference.candidates.map((candidate) => <span key={candidate.shiftId}><strong>{candidate.shiftName}</strong><small>{candidate.startTime} · {candidate.distanceMinutes} min away</small></span>)}</div>
      <div className="form-grid">
        <div className="form-field form-field-full"><label htmlFor="review-shift">Shift for this day</label><select id="review-shift" required autoFocus value={shiftId} onChange={(event) => setShiftId(event.target.value)}><option value="">Select shift</option>{shifts.filter((shift) => shift.active).map((shift) => <option key={shift.id} value={shift.id}>{shift.name} · {shift.startTime}–{shift.endTime}</option>)}</select><small>Confirmation applies only to this attendance date and does not create a permanent assignment.</small></div>
        <div className="form-field form-field-full"><label htmlFor="review-reason">Decision reason</label><textarea id="review-reason" required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></div>
      </div>
      <div className="form-actions form-actions-split"><Button type="button" variant="quiet" disabled={submitting !== null || reason.trim().length < 3} onClick={() => void resolve("reject")}><X size={14} />{submitting === "reject" ? "Rejecting…" : "Not a scheduled shift"}</Button><span /><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting !== null || shiftId === "" || reason.trim().length < 3}><Check size={14} />{submitting === "confirm" ? "Confirming…" : "Confirm shift"}</Button></div>
    </form> : null}
  </Modal>;
}

const emptyShift: Shift = {
  id: "",
  name: "",
  startTime: "08:30",
  endTime: "17:30",
  workingDays: [1, 2, 3, 4, 5],
  gracePeriodMinutes: 10,
  lateCalculationMode: "after_grace",
  breakMinutes: 60,
  punchMode: "first_last",
  earlyLeaveGraceMinutes: 5,
  overtimeEnabled: true,
  overtimeStartDelayMinutes: 15,
  overtimeMinimumMinutes: 30,
  overtimeRoundingMinutes: 15,
  overtimeRoundingMode: "floor",
  active: true,
};

function ShiftModal({ shift, organizationId, today, onClose, onSaved }: { shift: Shift | "new" | null; organizationId: string; today: string; onClose(): void; onSaved(): void }) {
  const initial = shift === null || shift === "new" ? emptyShift : shift;
  return <Modal open={shift !== null} title={shift === "new" ? "Create shift" : `Edit ${initial.name}`} description="All values feed the attendance engine; none are hard-coded in calculation." onClose={onClose}>
    {shift !== null ? <ShiftForm key={initial.id || "new"} initial={initial} organizationId={organizationId} today={today} onClose={onClose} onSaved={onSaved} /> : null}
  </Modal>;
}

function ShiftForm({ initial, organizationId, today, onClose, onSaved }: { initial: Shift; organizationId: string; today: string; onClose(): void; onSaved(): void }) {
  const [value, setValue] = useState(initial);
  const [recalculateFrom, setRecalculateFrom] = useState(`${today.slice(0, 7)}-01`);
  const [reason, setReason] = useState(initial.id ? "Attendance policy update" : "Initial shift setup");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const number = (field: keyof Shift) => (event: React.ChangeEvent<HTMLInputElement>) => setValue((current) => ({ ...current, [field]: Number(event.target.value) }));

  async function submit(event: FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    try { await saveShift({ organizationId, shiftId: value.id, name: value.name, startTime: value.startTime, endTime: value.endTime, workingDays: value.workingDays, gracePeriodMinutes: value.gracePeriodMinutes, lateCalculationMode: value.lateCalculationMode, breakMinutes: value.breakMinutes, punchMode: value.punchMode, earlyLeaveGraceMinutes: value.earlyLeaveGraceMinutes, overtimeEnabled: value.overtimeEnabled, overtimeStartDelayMinutes: value.overtimeStartDelayMinutes, overtimeMinimumMinutes: value.overtimeMinimumMinutes, overtimeRoundingMinutes: value.overtimeRoundingMinutes, overtimeRoundingMode: value.overtimeRoundingMode, active: value.active, recalculateFrom, reason }); onSaved(); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Shift could not be saved"); }
    finally { setSubmitting(false); }
  }

  return <form className="modal-content" onSubmit={submit}>
    {error ? <ErrorState message={error} /> : null}
    <div className="form-grid">
      <div className="form-field"><label htmlFor="shift-id">Shift ID</label><input id="shift-id" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" disabled={initial.id !== ""} value={value.id} onChange={(event) => setValue((current) => ({ ...current, id: event.target.value.toUpperCase() }))} placeholder="NORMAL" /></div>
      <div className="form-field"><label htmlFor="shift-name">Shift name</label><input id="shift-name" required minLength={2} value={value.name} onChange={(event) => setValue((current) => ({ ...current, name: event.target.value }))} /></div>
      <div className="form-field"><label htmlFor="shift-start">Start time</label><input id="shift-start" type="time" required value={value.startTime} onChange={(event) => setValue((current) => ({ ...current, startTime: event.target.value }))} /></div>
      <div className="form-field"><label htmlFor="shift-end">End time</label><input id="shift-end" type="time" required value={value.endTime} onChange={(event) => setValue((current) => ({ ...current, endTime: event.target.value }))} /></div>
      <div className="form-field"><label htmlFor="shift-grace">Grace period (min)</label><input id="shift-grace" type="number" min="0" max="240" value={value.gracePeriodMinutes} onChange={number("gracePeriodMinutes")} /></div>
      <div className="form-field"><label htmlFor="shift-late-rule">Late calculation</label><select id="shift-late-rule" value={value.lateCalculationMode} onChange={(event) => setValue((current) => ({ ...current, lateCalculationMode: event.target.value as Shift["lateCalculationMode"] }))}><option value="after_grace">Minutes after grace</option><option value="from_shift_start">All minutes from start</option></select></div>
      <div className="form-field"><label htmlFor="shift-break">Break duration (min)</label><input id="shift-break" type="number" min="0" max="480" value={value.breakMinutes} onChange={number("breakMinutes")} /></div>
      <div className="form-field"><label htmlFor="shift-punch-mode">Punch interpretation</label><select id="shift-punch-mode" value={value.punchMode} onChange={(event) => setValue((current) => ({ ...current, punchMode: event.target.value as Shift["punchMode"] }))}><option value="first_last">First and last</option><option value="explicit_status">Explicit IN / OUT</option></select></div>
      <div className="form-field"><label htmlFor="shift-early">Early leave grace (min)</label><input id="shift-early" type="number" min="0" max="240" value={value.earlyLeaveGraceMinutes} onChange={number("earlyLeaveGraceMinutes")} /></div>
      <div className="form-field"><label htmlFor="shift-ot-enabled">Overtime</label><select id="shift-ot-enabled" value={value.overtimeEnabled ? "yes" : "no"} onChange={(event) => setValue((current) => ({ ...current, overtimeEnabled: event.target.value === "yes" }))}><option value="yes">Enabled</option><option value="no">Disabled</option></select></div>
      {value.overtimeEnabled ? <><div className="form-field"><label htmlFor="shift-ot-delay">OT start delay (min)</label><input id="shift-ot-delay" type="number" min="0" max="720" value={value.overtimeStartDelayMinutes} onChange={number("overtimeStartDelayMinutes")} /></div><div className="form-field"><label htmlFor="shift-ot-min">Minimum OT (min)</label><input id="shift-ot-min" type="number" min="0" max="720" value={value.overtimeMinimumMinutes} onChange={number("overtimeMinimumMinutes")} /></div><div className="form-field"><label htmlFor="shift-ot-round">Rounding increment</label><input id="shift-ot-round" type="number" min="1" max="120" value={value.overtimeRoundingMinutes} onChange={number("overtimeRoundingMinutes")} /></div><div className="form-field"><label htmlFor="shift-ot-mode">Rounding mode</label><select id="shift-ot-mode" value={value.overtimeRoundingMode} onChange={(event) => setValue((current) => ({ ...current, overtimeRoundingMode: event.target.value as Shift["overtimeRoundingMode"] }))}><option value="none">No rounding</option><option value="floor">Round down</option><option value="nearest">Nearest increment</option><option value="ceil">Round up</option></select></div></> : null}
      <div className="form-field form-field-full"><label>Working days</label><div className="checkbox-row">{weekdays.map((day, index) => <label className="check-pill" key={day}><input type="checkbox" checked={value.workingDays.includes(index + 1)} onChange={(event) => setValue((current) => ({ ...current, workingDays: event.target.checked ? [...current.workingDays, index + 1].sort() : current.workingDays.filter((value) => value !== index + 1) }))} />{day}</label>)}</div></div>
      <div className="form-field"><label htmlFor="shift-recalc">Recalculate from</label><input id="shift-recalc" type="date" required value={recalculateFrom} onChange={(event) => setRecalculateFrom(event.target.value)} /></div>
      <div className="form-field"><label htmlFor="shift-reason">Change reason</label><input id="shift-reason" required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} /></div>
    </div>
    <div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting || value.workingDays.length === 0}>{submitting ? "Saving…" : "Save and queue recalculation"}</Button></div>
  </form>;
}

function AssignmentModal({ open, shifts, employees, organizationId, today, onClose, onSaved }: { open: boolean; shifts: Shift[]; employees: Employee[]; organizationId: string; today: string; onClose(): void; onSaved(): void }) {
  const [employeeId, setEmployeeId] = useState(""); const [shiftId, setShiftId] = useState(""); const [from, setFrom] = useState(today); const [to, setTo] = useState(""); const [reason, setReason] = useState("Employee schedule assignment"); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); setSubmitting(true); setError(null); try { await assignEmployeeShift({ organizationId, employeeId, shiftId, effectiveFrom: from, effectiveTo: to || null, reason }); onSaved(); } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Shift could not be assigned"); } finally { setSubmitting(false); } }
  return <Modal open={open} title="Assign employee shift" description="Assignments use effective date ranges so schedule history is never overwritten." onClose={onClose}><form className="modal-content" onSubmit={submit}>{error ? <ErrorState message={error} /> : null}<div className="form-grid"><div className="form-field form-field-full"><label htmlFor="assign-employee">Employee</label><select id="assign-employee" required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employeeCode} · {employee.name}</option>)}</select></div><div className="form-field form-field-full"><label htmlFor="assign-shift">Shift</label><select id="assign-shift" required value={shiftId} onChange={(event) => setShiftId(event.target.value)}><option value="">Select shift</option>{shifts.filter((shift) => shift.active).map((shift) => <option key={shift.id} value={shift.id}>{shift.name} · {shift.startTime}–{shift.endTime}</option>)}</select></div><div className="form-field"><label htmlFor="assign-from">Effective from</label><input id="assign-from" type="date" required value={from} onChange={(event) => setFrom(event.target.value)} /></div><div className="form-field"><label htmlFor="assign-to">Effective to</label><input id="assign-to" type="date" min={from} value={to} onChange={(event) => setTo(event.target.value)} /></div><div className="form-field form-field-full"><label htmlFor="assign-reason">Reason</label><textarea id="assign-reason" required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} /></div></div><div className="form-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={submitting}>{submitting ? "Assigning…" : "Assign shift"}</Button></div></form></Modal>;
}
