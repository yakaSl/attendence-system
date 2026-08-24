# Hikvision Device Setup

## Supported integration

The bridge targets Hikvision ISAPI attendance events and has fixtures for the DS-K1A8503EF response shapes. Confirm the terminal firmware exposes ISAPI, and use a dedicated device administrator credential where the model permits it.

## Network checklist

1. Give the terminal a stable IP address or DHCP reservation.
2. Confirm the bridge PC can reach the terminal port (normally HTTP 80 or HTTPS 443).
3. Keep the terminal and bridge PC clocks synchronized. Configure the correct IANA timezone in setup, such as `Asia/Colombo`.
4. Do not expose the terminal management port to the public internet.
5. Permit outbound HTTPS from the bridge PC to the configured Infact cloud endpoint.

## Configure through local setup

Open **Manage HikBridge** from the Start menu and enter:

- IP address or host and port
- HTTP/HTTPS choice
- device username and password
- a recognizable device name
- device timezone under advanced options

Select **Test device**. A successful result includes model, serial, firmware, and user count. The test does not upload users or reveal the password.

Next, paste the installation code and one-time bridge credential from the dashboard. Enter the HTTPS ingestion endpoint, test cloud connectivity, then save and start the service.

## Confirm fingerprint events

After enrolling/mapping an employee on the terminal, make one fingerprint punch. For an interactive diagnostic window, an administrator can run:

```powershell
& 'C:\Program Files\Infact\HikBridge\hikbridge.exe' test-events --minutes 10
```

Use `--raw` only during controlled troubleshooting: raw device payloads can contain employee identifiers and must be handled as sensitive operational data.
