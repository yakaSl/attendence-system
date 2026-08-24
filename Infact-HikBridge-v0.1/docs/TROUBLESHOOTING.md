# Troubleshooting Infact HikBridge

Start with the local status endpoint on the bridge PC:

```text
http://127.0.0.1:8765/status
```

Logs are JSON lines in `C:\ProgramData\Infact\HikBridge\logs\hikbridge.log`. They are rotated automatically. Do not send logs outside the authorized support channel because event metadata can contain employee identifiers.

## Hikvision unreachable

Confirm the IP/port, VLAN/firewall path, terminal power, and HTTP/HTTPS choice. Run `hikbridge.exe test-device`. The service continues retrying without discarding queued events.

## Wrong password

Open local setup as an administrator, enter the new device password, and test the device. The password is never printed in diagnostics. Repeated `401` responses normally mean the account/password or digest-auth settings are wrong.

## No fingerprint events

Confirm the device test succeeds, its clock/timezone is correct, the employee is enrolled, and a recent event is visible with `test-events --minutes 10`. Check logs for preserved malformed events or an event filter/firmware response that differs from the supported fixtures.

## Wrong device time

Correct NTP, timezone, and daylight-saving settings on the terminal. Then verify the timezone in local setup. Do not manually alter queue/checkpoint files; polling overlap captures boundary events after the clock is corrected.

## Cloud unavailable

Device polling remains independent. `pendingEvents` may rise while `lastCloudError` reports the connection issue. Check DNS, proxy/firewall, TLS interception, and the exact HTTPS ingestion endpoint. Queued events upload automatically when connectivity returns.

## Events stuck pending

Inspect `lastCloudError`, confirm the bridge credential is enabled, and run `hikbridge.exe test-cloud`. A rotated credential has only the configured grace window. Permanent per-event rejections are retained as failed evidence rather than retried forever.

## Service will not start

Run `hikbridge.exe status`, validate the configuration with `test-device` and `test-cloud`, and inspect the latest log. Confirm Local System and Administrators retain full access to `C:\ProgramData\Infact\HikBridge`.

## Port conflict

The service uses `127.0.0.1:8765` for status and setup uses `127.0.0.1:8766`. Find the owning process with `Get-NetTCPConnection -LocalPort <port>`. Change only the loopback status address in configuration if policy requires it; never bind either interface to `0.0.0.0`.

## Firebase authentication failure

For bridge ingestion, verify the installation code/device ID, one-time bridge credential, device enabled state, endpoint project/region, and system time used by replay checks. For dashboard sign-in, verify Firebase Authentication and organization membership separately.

## Employee not mapped

The punch is retained. In the dashboard, open Employees, review the unmapped device identity, and map it to the correct employee. Recalculation queues automatically after the mapping is saved.
