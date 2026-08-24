# Attendance Engine

## Contract

`calculateAttendance(input)` is a pure, deterministic calculation. It reads no clock, database, or environment state. `recalculateAttendance(db, organizationId, employeeId, date)` loads the historical inputs, invokes that calculation, and replaces the deterministic `attendanceDays/{employeeId}_{date}` projection. Calling it repeatedly with unchanged source data produces the same domain result.

Raw documents in `attendanceEvents` are never updated or deleted by attendance processing. A derived day records its source event IDs, applied adjustment IDs, exceptions, and `attendance-v1` calculation version.

## Workday and timezone rules

- Organization `timezone` is an IANA identifier such as `Asia/Colombo`; the Functions host timezone is irrelevant.
- `date` is the local date on which the assigned shift starts.
- A shift whose end time is less than or equal to its start time ends on the next local date. Thus `2026-08-23`, `22:00` to `06:00` owns punches through the morning of August 24.
- Scheduled local times are converted to zoned instants before durations are calculated. Elapsed minutes therefore remain correct across daylight-saving transitions.
- A shift accepts punches from its configurable early-arrival window through its configurable late-departure window. Defaults are six hours before and twelve hours after when these optional bounds are omitted.
- With no shift, only punches within the organization-local calendar date are considered.

Historical shift assignment uses the newest assignment whose `effectiveFrom <= date` and whose optional `effectiveTo >= date`. Employee documents do not carry an overwritten current-shift truth.

## Punch selection

`first_last` mode uses the earliest and latest in-window punches. One untyped punch is a check-in with a `missing_check_out` exception. An explicitly typed checkout-only punch produces `missing_check_in`.

`explicit_status` mode uses the first explicit check-in and last explicit checkout when at least one explicit direction exists. Otherwise it falls back to first/last behavior. Exact same-instant punches with the same direction do not affect the calculation and raise `duplicate_punches_ignored`; all source IDs remain traceable.

## Formulas

Let `S` be scheduled start, `E` scheduled end, `G` grace minutes, `B` unpaid break minutes, and `I`/`O` the selected check-in/check-out instants.

- Lateness begins only when `I > S + G`.
- `after_grace`: late minutes are `ceil(I - (S + G))`.
- `from_shift_start`: late minutes are `ceil(I - S)` once grace has been exceeded.
- Worked minutes are `max(0, floor(O - I) - B)`.
- Early-leave minutes are `ceil((E - earlyLeaveGrace) - O)` when checkout is before that threshold.
- Raw overtime is `floor(O - (E + overtimeStartDelay))`.
- Overtime below `minimumMinutes` is zero. Remaining overtime uses the configured `none`, `floor`, `nearest`, or `ceil` rounding mode and increment.

For the prompt's 08:30 start, ten-minute grace, and 08:47 arrival, `after_grace` yields seven minutes and `from_shift_start` yields 17. For an 18:22 checkout with overtime beginning at 17:45, raw overtime is 37 minutes; a 15-minute `floor` policy yields 30. The unrounded 37-minute value requires `roundingMode: none`.

## Leave, holidays, and exceptions

Without punches, the precedence is approved leave, non-working holiday, no assigned shift, working-day absence, then rest day. Punches produce `present` and also record `worked_on_leave`, `worked_on_holiday`, `worked_on_rest_day`, or `worked_without_shift` as appropriate.

Other explicit exceptions include missing check-in/out, invalid punch order, early arrival, late arrival, early leave, duplicate punches, and ignored out-of-window punches. Dashboards and reports should expose these flags rather than infer exceptions again.

## Corrections and audit

Only approved immutable documents in `manualAdjustments` participate in calculation. Supported commands set or clear first-in/last-out or explicitly set the day status. Multiple corrections apply in approval-time order.

`createManualAdjustment` is restricted to organization owners and HR admins, uses a caller-provided UUID as an idempotency key, stores the old calculated state with the adjustment, recalculates, and creates an immutable `adjustmentAudits` record containing the old state, adjustment, new state, reason, actor, timestamp, and calculation version. Reusing the UUID with different content is rejected.

## Automatic recalculation

- A newly stored mapped event recalculates its organization-local date and the previous candidate date so overnight work is covered.
- Identity mapping creates a cursor-based job. A scheduled processor reads matching immutable raw events in pages and recalculates affected dates without rewriting them.
- HR can call `recalculateAttendanceDay` for a specific employee/date after a policy or historical-data change.
- A delayed offline punch replaces only the derived day. The raw evidence and any audit history remain unchanged.
- Shift/assignment callables and leave/holiday triggers create bounded recalculation jobs for affected employee/date ranges.
- Persistent job errors are retried five times and then surfaced as failed rather than silently blocking the queue.

Punch queries fail loudly above 1,000 records per identity/workday and correction queries above 100 approved adjustments. These safety limits prevent a partial derived result from being mistaken for complete attendance.
