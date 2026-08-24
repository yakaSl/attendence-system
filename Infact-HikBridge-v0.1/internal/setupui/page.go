package setupui

const pageHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Infact HikBridge Setup</title>
  <style nonce="{{.Nonce}}">
    :root { color-scheme: light; --ink:#172522; --muted:#687572; --line:#d9e1de; --paper:#f5f7f6; --white:#fff; --teal:#087f72; --teal-dark:#075f57; --soft:#e9f4f1; --warn:#9c4b18; --danger:#a93838; --service:#142522; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--paper); color:var(--ink); font-family:Aptos,"Segoe UI",sans-serif; font-size:15px; }
    button,input,select { font:inherit; }
    .frame { min-height:100vh; display:grid; grid-template-columns:290px minmax(0,1fr); }
    .rail { background:#142522; color:#f4faf8; padding:42px 34px; display:flex; flex-direction:column; position:sticky; top:0; height:100vh; }
    .brand { display:flex; align-items:center; gap:12px; font-weight:700; letter-spacing:-.02em; font-size:19px; }
    .mark { width:31px; height:31px; border:1px solid #72a9a0; display:grid; place-items:center; color:#9ad4ca; font-weight:800; }
    .intro { margin:70px 0 34px; }
    .eyebrow { color:#8fb9b2; text-transform:uppercase; letter-spacing:.13em; font-size:11px; font-weight:700; }
    .intro h1 { font-size:34px; line-height:1.07; letter-spacing:-.045em; margin:12px 0 16px; max-width:210px; }
    .intro p { color:#b8c9c6; line-height:1.55; margin:0; }
    .steps { list-style:none; padding:0; margin:0; display:grid; gap:20px; counter-reset:step; }
    .steps li { counter-increment:step; display:grid; grid-template-columns:28px 1fr; gap:12px; align-items:center; color:#b8c9c6; }
    .steps li::before { content:counter(step); width:27px; height:27px; border:1px solid #4e6964; display:grid; place-items:center; font-size:12px; }
    .steps li.active { color:white; }
    .steps li.active::before { border-color:#6bc0b2; background:#21443e; }
    .rail-foot { margin-top:auto; color:#79918c; font-size:12px; }
    main { padding:54px clamp(32px,6vw,88px) 80px; max-width:1040px; width:100%; }
    .topline { display:flex; justify-content:space-between; align-items:end; gap:24px; padding-bottom:24px; border-bottom:1px solid var(--line); }
    .topline h2 { margin:4px 0 0; font-size:25px; letter-spacing:-.035em; }
    .local { color:var(--muted); font-size:12px; display:flex; align-items:center; gap:7px; }
    .local::before { content:""; width:7px; height:7px; border-radius:50%; background:#31a58e; box-shadow:0 0 0 3px #d9eee9; }
    form { display:grid; gap:34px; margin-top:34px; }
    section { background:var(--white); border:1px solid var(--line); padding:28px; }
    .section-head { display:flex; justify-content:space-between; gap:24px; margin-bottom:23px; }
    .section-head h3 { margin:0 0 5px; font-size:18px; letter-spacing:-.02em; }
    .section-head p { margin:0; color:var(--muted); font-size:13px; }
    .number { color:var(--teal); font-weight:700; font-size:13px; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
    label { display:grid; gap:7px; color:#465551; font-size:13px; font-weight:600; }
    .span-2 { grid-column:span 2; }
    input,select { width:100%; min-height:43px; border:1px solid #cbd5d2; background:#fff; padding:9px 11px; color:var(--ink); outline:none; }
    input:focus,select:focus { border-color:var(--teal); box-shadow:0 0 0 3px #dcefeb; }
    input::placeholder { color:#9ba6a3; }
    .address { display:grid; grid-template-columns:minmax(0,1fr) 106px; gap:9px; }
    .check { display:flex; align-items:center; gap:9px; min-height:43px; font-weight:500; }
    .check input { width:17px; min-height:17px; accent-color:var(--teal); }
    .actions { display:flex; align-items:center; gap:13px; margin-top:21px; flex-wrap:wrap; }
    button { min-height:40px; border:1px solid #b8c7c3; background:#fff; color:var(--ink); padding:8px 15px; cursor:pointer; font-weight:650; transition:background-color .16s ease,border-color .16s ease,transform .16s ease,opacity .16s ease; }
    button:hover { border-color:#7d918c; transform:translateY(-1px); }
    button.primary { color:#fff; background:var(--teal); border-color:var(--teal); }
    button.primary:hover { background:var(--teal-dark); }
    button:disabled { cursor:not-allowed; opacity:.48; transform:none; }
    button.danger { color:#9f3939; border-color:#ddb8b8; background:#fffafa; }
    button.danger:hover { color:#7f2424; border-color:#bf7e7e; background:#fff4f4; }
    .result { flex:1; min-width:240px; min-height:40px; padding:10px 12px; background:#f7f9f8; border-left:3px solid #b5c2bf; color:var(--muted); font-size:13px; line-height:1.45; }
    .result.ok { background:#edf7f4; border-color:#2a9b85; color:#20685b; }
    .result.error { background:#fff4ef; border-color:#ca6236; color:#8b3f1d; }
    details { margin-top:18px; border-top:1px solid #e7ecea; padding-top:16px; }
    summary { color:var(--muted); cursor:pointer; font-size:13px; font-weight:650; }
    details .grid { margin-top:16px; }
    .footer-actions { display:flex; align-items:center; justify-content:space-between; gap:20px; border-top:1px solid var(--line); padding-top:28px; }
    .save-side { display:flex; align-items:center; gap:13px; }
    .save-side .primary { min-height:45px; padding-inline:20px; }
    #global-status { color:var(--muted); font-size:13px; max-width:460px; }
    .notice { padding:13px 15px; background:#f0f5f3; color:#52615e; border-left:3px solid #7aa79f; font-size:13px; line-height:1.5; margin-top:18px; }
    .service-console { margin-top:24px; background:var(--service); color:#f4faf8; padding:25px 27px 22px; border:1px solid #29413c; animation:enter .4s ease both; }
    .service-console-head { display:flex; align-items:start; justify-content:space-between; gap:24px; }
    .service-console .eyebrow { color:#81aaa3; }
    .service-console h3 { margin:6px 0 0; font-size:20px; letter-spacing:-.025em; }
    .service-state { display:flex; align-items:center; gap:12px; min-width:210px; justify-content:flex-end; }
    .service-beacon { width:11px; height:11px; border-radius:50%; background:#80928e; box-shadow:0 0 0 5px rgba(128,146,142,.12); flex:0 0 auto; }
    .state-running .service-beacon { background:#45c8aa; box-shadow:0 0 0 5px rgba(69,200,170,.14); animation:pulse 2s ease-in-out infinite; }
    .state-stopped .service-beacon { background:#e6a75e; box-shadow:0 0 0 5px rgba(230,167,94,.12); }
    .state-not-installed .service-beacon,.state-unavailable .service-beacon { background:#87938f; }
    .service-state-copy { text-align:right; }
    .service-state-label { font-size:14px; font-weight:750; text-transform:capitalize; }
    .service-state-meta { color:#93aaa5; font-size:12px; margin-top:3px; }
    .service-controls { display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-top:24px; padding-top:20px; border-top:1px solid #304843; }
    .service-controls button { color:#eef6f4; border-color:#526d67; background:#1b302c; }
    .service-controls button:hover { border-color:#7fa39b; background:#223a35; }
    .service-controls button.primary { border-color:#36a995; background:#168875; }
    .service-controls button.primary:hover { background:#117363; }
    .service-controls button.danger { margin-left:auto; color:#f2c2c2; border-color:#805454; background:#302524; }
    .service-controls button.danger:hover { border-color:#ad7373; background:#3b2827; }
    .service-message { margin-top:14px; color:#aebfbb; font-size:12px; min-height:18px; line-height:1.45; }
    .service-message.ok { color:#86d4c3; }
    .service-message.error { color:#f0a79c; }
    .confirm-bar { display:flex; align-items:center; justify-content:space-between; gap:18px; margin-top:15px; padding:14px 0 0; border-top:1px solid #5a4140; }
    .confirm-bar[hidden] { display:none; }
    .confirm-copy { color:#e9ceca; font-size:12px; line-height:1.45; max-width:520px; }
    .confirm-actions { display:flex; gap:8px; flex:0 0 auto; }
    section { animation:enter .4s ease both; }
    section:nth-of-type(2) { animation-delay:.05s; }
    section:nth-of-type(3) { animation-delay:.1s; }
    @keyframes enter { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    @keyframes pulse { 0%,100% { box-shadow:0 0 0 5px rgba(69,200,170,.12); } 50% { box-shadow:0 0 0 9px rgba(69,200,170,.02); } }
    @media (max-width:820px) { .frame { grid-template-columns:1fr; } .rail { position:static; height:auto; padding:25px 28px; } .intro { margin:36px 0 25px; } .intro h1 { max-width:none; font-size:29px; } .steps { grid-template-columns:repeat(4,1fr); gap:10px; } .steps li { gap:7px; font-size:12px; } .rail-foot { margin-top:25px; } main { padding:34px 22px 55px; } }
    @media (max-width:620px) { .grid { grid-template-columns:1fr; } .span-2 { grid-column:auto; } .steps { grid-template-columns:repeat(2,1fr); } .topline,.service-console-head { align-items:start; flex-direction:column; } .service-state { justify-content:flex-start; min-width:0; } .service-state-copy { text-align:left; } .service-controls button { flex:1 1 calc(50% - 9px); } .service-controls button.danger { margin-left:0; } .confirm-bar { align-items:flex-start; flex-direction:column; } section { padding:22px 18px; } .footer-actions { align-items:flex-start; flex-direction:column; } .save-side { width:100%; flex-wrap:wrap; } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; animation-duration:.01ms!important; animation-iteration-count:1!important; transition-duration:.01ms!important; } }
  </style>
</head>
<body>
  <div class="frame">
    <aside class="rail">
      <div class="brand"><span class="mark">I</span><span>Infact HikBridge</span></div>
      <div class="intro"><div class="eyebrow">Local service manager</div><h1>Configure and control HikBridge.</h1><p>Manage one attendance terminal and its Windows service from this PC.</p></div>
      <ol class="steps"><li class="active">Status</li><li class="active">Device</li><li class="active">Cloud</li><li class="active">Schedule</li></ol>
      <div class="rail-foot">Version {{.Version}} - Bound to this PC only</div>
    </aside>
    <main>
      <div class="topline"><div><div class="eyebrow">Control center</div><h2>Bridge service &amp; configuration</h2></div><div class="local">127.0.0.1 secure local session</div></div>
      <div class="notice">Stored passwords and bridge credentials are never sent back to this page. Leave a secret field blank to keep its current value.</div>
      <div class="service-console state-unavailable" id="service-console">
        <div class="service-console-head">
          <div><div class="eyebrow">Windows service</div><h3>Infact Hikvision Bridge</h3></div>
          <div class="service-state"><span class="service-beacon" aria-hidden="true"></span><div class="service-state-copy"><div class="service-state-label" id="service-state-label">Checking status</div><div class="service-state-meta" id="service-state-meta">Contacting Windows Service Control Manager</div></div></div>
        </div>
        <div class="service-controls" aria-label="Windows service controls">
          <button id="service-install" type="button">Install service</button>
          <button id="service-start" class="primary" type="button">Start</button>
          <button id="service-stop" type="button">Stop</button>
          <button id="service-restart" type="button">Restart</button>
          <button id="service-uninstall" class="danger" type="button">Uninstall service</button>
        </div>
        <div class="service-message" id="service-message" aria-live="polite">Loading service state...</div>
        <div class="confirm-bar" id="uninstall-confirm" hidden>
          <div class="confirm-copy">Remove the Windows service? The configuration, logs, and queued attendance events will remain on this PC.</div>
          <div class="confirm-actions"><button id="uninstall-cancel" type="button">Cancel</button><button id="uninstall-confirm-button" class="danger" type="button">Remove service</button></div>
        </div>
      </div>
      <form id="setup-form">
        <section>
          <div class="section-head"><div><h3>Hikvision device</h3><p>Network and administrator credentials for the local terminal.</p></div><span class="number">01</span></div>
          <div class="grid">
            <label>IP address or host<div class="address"><input id="address" autocomplete="off" required placeholder="192.168.1.64"><input id="port" type="number" min="1" max="65535" required aria-label="Port" placeholder="80"></div></label>
            <label>Device name<input id="device-name" maxlength="120" required placeholder="Main office attendance"></label>
            <label>Username<input id="username" autocomplete="username" required placeholder="admin"></label>
            <label>Password<input id="password" type="password" autocomplete="new-password" placeholder="Enter device password"></label>
          </div>
          <details><summary>Advanced device options</summary><div class="grid"><label>Device timezone<input id="timezone" required placeholder="Asia/Colombo"></label><label class="check"><input id="https" type="checkbox">Use HTTPS for this device</label></div></details>
          <div class="actions"><button id="test-device" type="button">Test device</button><div id="device-result" class="result" aria-live="polite">Run a connection test before saving.</div></div>
        </section>

        <section>
          <div class="section-head"><div><h3>Cloud registration</h3><p>Use the one-time values shown when this bridge was provisioned.</p></div><span class="number">02</span></div>
          <div class="grid">
            <label>Organization / installation code<input id="installation-code" maxlength="64" required placeholder="office-main-01"></label>
            <label>Bridge credential<input id="bridge-credential" type="password" autocomplete="new-password" placeholder="Paste the one-time credential"></label>
            <label class="check span-2"><input id="cloud-enabled" type="checkbox" checked>Enable cloud synchronization</label>
          </div>
          <details><summary>Advanced cloud options</summary><div class="grid"><label class="span-2">Cloud ingestion endpoint<input id="ingest-url" type="url" placeholder="https://region-project.cloudfunctions.net/hikbridgeV1Events"></label></div></details>
          <div class="actions"><button id="test-cloud" type="button">Test cloud</button><div id="cloud-result" class="result" aria-live="polite">The test verifies the installation code and credential.</div></div>
        </section>

        <section>
          <div class="section-head"><div><h3>Windows service</h3><p>Choose how often HikBridge checks the terminal for new punches.</p></div><span class="number">03</span></div>
          <div class="grid"><label>Polling interval<select id="poll"><option value="5">Every 5 seconds</option><option value="10">Every 10 seconds</option><option value="30">Every 30 seconds</option><option value="60">Every minute</option></select></label></div>
        </section>

        <div class="footer-actions"><button id="quit" type="button">Close setup</button><div class="save-side"><span id="global-status" aria-live="polite">Configuration has not been changed.</span><button class="primary" id="save" type="submit">Save &amp; start service</button></div></div>
      </form>
    </main>
  </div>
  <script nonce="{{.Nonce}}">
    const csrf = "{{.CSRF}}";
    const byId = (id) => document.getElementById(id);
    const form = byId("setup-form");

    function setResult(id, message, kind) {
      const node = byId(id);
      node.textContent = message;
      node.className = "result" + (kind ? " " + kind : "");
    }

    function collect() {
      return {
        device: {
          address: byId("address").value.trim(),
          port: Number(byId("port").value),
          useHttps: byId("https").checked,
          username: byId("username").value.trim(),
          password: byId("password").value,
          deviceName: byId("device-name").value.trim(),
          timeZone: byId("timezone").value.trim()
        },
        cloud: {
          enabled: byId("cloud-enabled").checked,
          installationCode: byId("installation-code").value.trim(),
          bridgeCredential: byId("bridge-credential").value,
          ingestUrl: byId("ingest-url").value.trim()
        },
        service: { pollIntervalSeconds: Number(byId("poll").value) }
      };
    }

    async function api(path, body) {
      const options = body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-HikBridge-CSRF": csrf },
        body: JSON.stringify(body)
      };
      const response = await fetch(path, options);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "The local setup request failed.");
      return payload;
    }

    function busy(button, active, label) {
      if (active) { button.dataset.label = button.textContent; button.textContent = label; }
      else if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = active;
    }

    const serviceButtons = ["service-install", "service-start", "service-stop", "service-restart", "service-uninstall"];
    let currentService = null;
    let serviceActionBusy = false;

    function serviceMessage(message, kind) {
      const node = byId("service-message");
      node.textContent = message;
      node.className = "service-message" + (kind ? " " + kind : "");
    }

    function renderService(service, quiet) {
      currentService = service;
      const state = service.state || "unavailable";
      const label = state === "not-installed" ? "Not installed" : state.replaceAll("-", " ");
      const consoleNode = byId("service-console");
      consoleNode.className = "service-console state-" + state;
      byId("service-state-label").textContent = label;
      if (!service.manageable) {
        byId("service-state-meta").textContent = "Service controls are unavailable in this session";
      } else if (!service.installed) {
        byId("service-state-meta").textContent = service.configured ? "Configuration ready" : "Save configuration before installation";
      } else if (service.processId) {
        byId("service-state-meta").textContent = "Process ID " + service.processId;
      } else {
        byId("service-state-meta").textContent = "Installed with automatic startup";
      }

      const pending = state.includes("pending");
      byId("service-install").disabled = serviceActionBusy || !service.manageable || service.installed || !service.configured;
      byId("service-start").disabled = serviceActionBusy || !service.manageable || !service.installed || state === "running" || pending;
      byId("service-stop").disabled = serviceActionBusy || !service.manageable || !service.installed || state !== "running";
      byId("service-restart").disabled = serviceActionBusy || !service.manageable || !service.installed || pending;
      byId("service-uninstall").disabled = serviceActionBusy || !service.manageable || !service.installed || pending;

      if (!quiet) {
        if (!service.manageable) serviceMessage("Open the Windows setup command without --no-service to manage the service.", "");
        else if (state === "running") serviceMessage("Service is running and polling the attendance terminal.", "ok");
        else if (state === "stopped") serviceMessage("Service is installed but stopped.", "");
        else if (state === "not-installed" && service.configured) serviceMessage("Configuration is ready. Install the service when this PC is ready to run the bridge.", "");
        else serviceMessage("Save a valid configuration before installing the service.", "");
      }
    }

    async function refreshService(quiet) {
      try {
        renderService(await api("/api/service"), quiet);
      } catch (error) {
        byId("service-console").className = "service-console state-unavailable";
        byId("service-state-label").textContent = "Status unavailable";
        byId("service-state-meta").textContent = "Windows service state could not be read";
        serviceButtons.forEach((id) => { byId(id).disabled = true; });
        if (!quiet) serviceMessage(error.message, "error");
      }
    }

    async function runServiceAction(action, button, pendingLabel) {
      serviceActionBusy = true;
      byId("uninstall-confirm").hidden = true;
      if (currentService) renderService(currentService, true);
      busy(button, true, pendingLabel);
      serviceMessage(pendingLabel + "...", "");
      try {
        const result = await api("/api/service-action", { action });
        renderService(result.service, true);
        serviceMessage(result.message, "ok");
      } catch (error) {
        serviceMessage(error.message, "error");
      } finally {
        serviceActionBusy = false;
        busy(button, false);
        await refreshService(true);
      }
    }

    async function load() {
      try {
        const state = await api("/api/state");
        byId("address").value = state.address;
        byId("port").value = state.port;
        byId("https").checked = state.useHttps;
        byId("username").value = state.username;
        byId("device-name").value = state.deviceName;
        byId("timezone").value = state.timeZone;
        byId("installation-code").value = state.installationCode;
        byId("cloud-enabled").checked = state.cloudEnabled || !state.configured;
        byId("ingest-url").value = state.ingestUrl;
        byId("poll").value = String(state.pollIntervalSeconds);
        if (state.hasDevicePassword) byId("password").placeholder = "Stored securely — leave blank to keep";
        if (state.hasBridgeCredential) byId("bridge-credential").placeholder = "Stored securely — leave blank to keep";
        byId("global-status").textContent = state.configured ? "Existing configuration loaded. Secrets remain hidden." : "Complete the three sections, then save.";
      } catch (error) {
        byId("global-status").textContent = error.message;
      }
    }

    byId("service-install").addEventListener("click", () => runServiceAction("install", byId("service-install"), "Installing"));
    byId("service-start").addEventListener("click", () => runServiceAction("start", byId("service-start"), "Starting"));
    byId("service-stop").addEventListener("click", () => runServiceAction("stop", byId("service-stop"), "Stopping"));
    byId("service-restart").addEventListener("click", () => runServiceAction("restart", byId("service-restart"), "Restarting"));
    byId("service-uninstall").addEventListener("click", () => { byId("uninstall-confirm").hidden = false; });
    byId("uninstall-cancel").addEventListener("click", () => { byId("uninstall-confirm").hidden = true; });
    byId("uninstall-confirm-button").addEventListener("click", () => runServiceAction("uninstall", byId("uninstall-confirm-button"), "Removing"));

    byId("test-device").addEventListener("click", async () => {
      const button = byId("test-device"); busy(button, true, "Testing…"); setResult("device-result", "Connecting to the terminal…", "");
      try {
        const result = await api("/api/test-device", collect());
        setResult("device-result", "✓ Device connected · Model " + (result.model || "not reported") + " · Serial " + (result.serial || "not reported") + " · Firmware " + (result.firmware || "not reported") + " · Users " + result.users, "ok");
      } catch (error) { setResult("device-result", error.message, "error"); }
      finally { busy(button, false); }
    });

    byId("test-cloud").addEventListener("click", async () => {
      const button = byId("test-cloud"); busy(button, true, "Testing…"); setResult("cloud-result", "Verifying the bridge registration…", "");
      try {
        const result = await api("/api/test-cloud", collect());
        setResult("cloud-result", "✓ Cloud connected · Organization " + result.organizationId + (result.branchId ? " · Branch " + result.branchId : ""), "ok");
      } catch (error) { setResult("cloud-result", error.message, "error"); }
      finally { busy(button, false); }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = byId("save"); busy(button, true, "Saving…"); byId("global-status").textContent = "Securing configuration and applying the Windows service…";
      try {
        const result = await api("/api/save", collect());
        byId("password").value = ""; byId("bridge-credential").value = "";
        byId("password").placeholder = "Stored securely — leave blank to keep";
        byId("bridge-credential").placeholder = "Stored securely — leave blank to keep";
        byId("global-status").textContent = "✓ Configuration saved; service " + result.service + ".";
        await refreshService(true);
      } catch (error) { byId("global-status").textContent = error.message; }
      finally { busy(button, false); }
    });

    byId("quit").addEventListener("click", async () => {
      try { await api("/api/quit", {}); document.body.innerHTML = "<main style='padding:48px;font-family:Segoe UI,sans-serif'><h2>Setup closed</h2><p>You can close this browser tab.</p></main>"; }
      catch (error) { byId("global-status").textContent = error.message; }
    });

    load();
    refreshService(false);
    window.setInterval(() => {
      if (document.visibilityState === "visible" && !serviceActionBusy) refreshService(true);
    }, 3000);
  </script>
</body>
</html>`
