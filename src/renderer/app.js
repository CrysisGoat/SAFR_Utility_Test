'use strict';

/**
 * SAFR Utility — application logic, the JS counterpart of 247nm_Laser_GUI.py.
 *
 * One interval timer drives both the telemetry poll (`c?`, `t?`, `a?`, `l?`)
 * and the strip-chart sample, so the plot never shows a value the board has
 * not actually reported since the previous point.
 */

/** Plot/legend series, in the same order the Python GUI stacked them. */
const SERIES = [
  { name: 'Pr:BYF Temp', units: '°C', color: '#ff6b6b', axis: 'left', digits: 2 },
  { name: 'BBO Temp', units: '°C', color: '#ffd166', axis: 'left', digits: 2 },
  { name: 'Diode Temp', units: '°C', color: '#06d6a0', axis: 'left', digits: 2 },
  { name: 'TEC Voltage', units: 'V', color: '#4dabf7', axis: 'right', digits: 3 }
];

const CSV_HEADER = 'Time(s),PrBYFTemp(C),BBOTemp(C),DiodeTemp(C),TECVoltage(V)';
const MAX_BUFFER_POINTS = 100000;
const MAX_PLOT_POINTS = 3000;
const MAX_MONITOR_LINES = 500;

const host = window.safrHost;

const el = (id) => document.getElementById(id);

const ui = {
  connectionBadge: el('connectionBadge'),
  portSelect: el('portSelect'),
  refreshPortsButton: el('refreshPortsButton'),
  connectButton: el('connectButton'),
  firmwareField: el('firmwareField'),
  queryFirmwareButton: el('queryFirmwareButton'),
  currentField: el('currentField'),
  currentSetField: el('currentSetField'),
  byfSetpointField: el('byfSetpointField'),
  byfSetpointSetField: el('byfSetpointSetField'),
  bboSetpointField: el('bboSetpointField'),
  bboSetpointSetField: el('bboSetpointSetField'),
  byfTempField: el('byfTempField'),
  bboTempField: el('bboTempField'),
  diodeTempField: el('diodeTempField'),
  tecVoltageField: el('tecVoltageField'),
  laserPowerFlag: el('laserPowerFlag'),
  laserTimeoutFlag: el('laserTimeoutFlag'),
  laserOnButton: el('laserOnButton'),
  laserOffButton: el('laserOffButton'),
  tecDiagnosticFlag: el('tecDiagnosticFlag'),
  manualCommandField: el('manualCommandField'),
  manualSendButton: el('manualSendButton'),
  statusLine: el('statusLine'),
  legend: el('legend'),
  plotCanvas: el('plotCanvas'),
  hoursField: el('hoursField'),
  minutesField: el('minutesField'),
  secondsField: el('secondsField'),
  rateSlider: el('rateSlider'),
  rateReadout: el('rateReadout'),
  recordButton: el('recordButton'),
  resetButton: el('resetButton'),
  monitorPauseFlag: el('monitorPauseFlag'),
  monitorClearButton: el('monitorClearButton'),
  monitorLog: el('monitorLog'),
  sweepStartField: el('sweepStartField'),
  sweepEndField: el('sweepEndField'),
  sweepStepField: el('sweepStepField'),
  sweepHoldField: el('sweepHoldField'),
  sweepStatus: el('sweepStatus'),
  sweepButton: el('sweepButton')
};

const state = {
  safr: null,
  connecting: false,
  ports: [],
  timer: null,
  updateInterval: Number(ui.rateSlider.value),
  startTime: 0,
  offset: 0,
  totalSeconds: 15,
  saved: { hours: 0, minutes: 0, seconds: 15 },
  x: [],
  y: SERIES.map(() => []),
  recording: false,
  logPath: null,
  pendingRows: [],
  sweep: null,
  sweepTimer: null
};

const plot = new window.DualAxisPlot(ui.plotCanvas, {
  xLabel: 'Time (s)',
  leftLabel: 'Temperature (°C)',
  rightLabel: 'Voltage (V)'
});
plot.setSeries(SERIES.map((s) => ({ name: s.name, color: s.color, axis: s.axis })));

// ---------------------------------------------------------------------- legend

const legendValues = SERIES.map((s) => {
  const item = document.createElement('span');
  item.className = 'legend-item';

  const swatch = document.createElement('span');
  swatch.className = 'legend-swatch';
  swatch.style.background = s.color;

  const label = document.createElement('span');
  label.textContent = s.name;

  const value = document.createElement('span');
  value.className = 'legend-value';
  value.textContent = '--';

  item.append(swatch, label, value);
  ui.legend.append(item);
  return value;
});

// ---------------------------------------------------------------------- status

function setStatus(message, kind = '') {
  ui.statusLine.textContent = message;
  ui.statusLine.className = `status ${kind}`.trim();
}

function logMonitor(text, kind) {
  if (ui.monitorPauseFlag.checked) return;
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text;
  ui.monitorLog.append(line);
  while (ui.monitorLog.childElementCount > MAX_MONITOR_LINES) {
    ui.monitorLog.removeChild(ui.monitorLog.firstChild);
  }
  ui.monitorLog.scrollTop = ui.monitorLog.scrollHeight;
}

// ----------------------------------------------------------------- port picker

function describePort(port) {
  const name = port.portName || port.portId;
  const detail = [port.displayName, port.serialNumber].filter(Boolean).join(' ');
  const ids = port.vendorId && port.productId ? `${port.vendorId}:${port.productId}` : '';
  const suffix = [detail, ids].filter(Boolean).join('  ');
  return suffix ? `${name} — ${suffix}` : name;
}

function populatePorts(ports) {
  state.ports = ports || [];
  const previous = ui.portSelect.value;
  ui.portSelect.replaceChildren();

  if (!state.ports.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No serial ports found';
    ui.portSelect.append(option);
    ui.portSelect.disabled = true;
    return;
  }

  state.ports.forEach((port) => {
    const option = document.createElement('option');
    option.value = port.portName;
    option.textContent = describePort(port);
    option.title = option.textContent;
    ui.portSelect.append(option);
  });

  ui.portSelect.disabled = false;
  if (state.ports.some((p) => p.portName === previous)) ui.portSelect.value = previous;
  // The select is narrow, so surface the full description on hover.
  ui.portSelect.title = ui.portSelect.selectedOptions[0]
    ? ui.portSelect.selectedOptions[0].textContent
    : '';
}

async function refreshPorts(quiet = false) {
  ui.refreshPortsButton.disabled = true;
  try {
    populatePorts(await host.listPorts());
    if (!state.ports.length) {
      setStatus('No serial ports detected. Check the cable and USB-serial driver.', 'error');
    } else if (!quiet) {
      setStatus(`Found ${state.ports.length} serial port(s).`);
    }
  } finally {
    ui.refreshPortsButton.disabled = false;
  }
}

// ------------------------------------------------------------------ connection

function setConnectedUI(connected) {
  ui.connectionBadge.textContent = connected ? 'Connected' : 'Disconnected';
  ui.connectionBadge.className = `badge ${connected ? 'badge-on' : 'badge-off'}`;
  ui.connectButton.textContent = connected ? 'Disconnect' : 'Connect';
  ui.portSelect.disabled = connected || !state.ports.length;
  ui.refreshPortsButton.disabled = connected;

  [
    ui.queryFirmwareButton,
    ui.currentSetField,
    ui.byfSetpointSetField,
    ui.bboSetpointSetField,
    ui.laserOnButton,
    ui.laserOffButton,
    ui.tecDiagnosticFlag,
    ui.manualCommandField,
    ui.manualSendButton,
    ui.recordButton,
    ui.sweepStartField,
    ui.sweepEndField,
    ui.sweepStepField,
    ui.sweepHoldField,
    ui.sweepButton
  ].forEach((node) => {
    node.disabled = !connected;
  });
  describeSweepPlan();

  if (!connected) {
    ui.laserPowerFlag.checked = false;
    ui.laserTimeoutFlag.checked = false;
    ui.tecDiagnosticFlag.checked = false;
  }
}

function handleSafrEvent(name, payload) {
  switch (name) {
    case 'version':
      ui.firmwareField.value = payload;
      break;
    case 'externTemp2':
      ui.byfTempField.value = payload.toFixed(2);
      break;
    case 'laserTemp':
      ui.bboTempField.value = payload.toFixed(2);
      break;
    case 'externTemp1':
      ui.diodeTempField.value = payload.toFixed(2);
      break;
    case 'tecVoltage':
      // The Python GUI wrote this into the row's label instead of its field.
      ui.tecVoltageField.value = payload.toFixed(3);
      break;
    case 'byfSetpoint':
      ui.byfSetpointField.value = payload.toFixed(2);
      break;
    case 'bboSetpoint':
      ui.bboSetpointField.value = payload.toFixed(2);
      break;
    case 'laserStatus':
      // vals[0] = output on, vals[1] = current (A), vals[3] = 0 while the
      // firmware timeout is armed — the same inversion the Python GUI used.
      ui.laserPowerFlag.checked = payload[0] !== 0;
      ui.currentField.value = Number.isFinite(payload[1]) ? payload[1].toFixed(2) : '';
      ui.laserTimeoutFlag.checked = payload[3] === 0;
      watchSweepOutput(payload[0] !== 0);
      break;
    case 'disconnect':
      setStatus('Serial port closed by the device.', 'error');
      disconnect();
      break;
    default:
      break;
  }
}

async function connect() {
  const portName = ui.portSelect.value;
  if (!portName) {
    setStatus('No port selected. Press Refresh first.', 'error');
    return;
  }

  state.connecting = true;
  ui.connectButton.disabled = true;

  try {
    // The main process resolves this to a Chromium port handle by name.
    await host.setDesiredPort(portName);
    const port = await navigator.serial.requestPort();

    const safr = new window.SAFR({
      onEvent: handleSafrEvent,
      onTx: (cmd) => logMonitor(`> ${cmd}`, 'tx'),
      onRx: (line) => logMonitor(`< ${line}`, 'rx'),
      onError: (err) => {
        logMonitor(`! ${err.message}`, 'err');
        setStatus(`Serial error: ${err.message}`, 'error');
      }
    });

    await safr.open(port, 115200);
    state.safr = safr;

    safr.getVersion();
    safr.setLaserOverride(1);

    resetBuffers();
    state.startTime = performance.now();
    startTimer();
    setConnectedUI(true);
    setStatus(`Connected at 115200 baud. Polling every ${state.updateInterval} ms.`, 'ok');

    // The board answers `v?` immediately; silence means it probably is not a
    // SAFR controller (the Python GUI probed every port the same way).
    window.setTimeout(() => {
      if (state.safr === safr && !safr.version) {
        setStatus('Connected, but the device did not answer "v?". Is this a SAFR board?', 'error');
      }
    }, 1500);
  } catch (err) {
    // Chromium rejects with NotFoundError when no port matched the name; a
    // Refresh now shows the names Chromium itself reported.
    const message = /No port selected|NotFoundError/i.test(err.message)
      ? `Chromium does not expose "${portName}". Press Refresh and pick again.`
      : err.message;
    setStatus(`Connect failed: ${message}`, 'error');
    state.safr = null;
    setConnectedUI(false);
    refreshPorts(true);
  } finally {
    state.connecting = false;
    ui.connectButton.disabled = false;
  }
}

async function disconnect() {
  stopTimer();
  if (state.sweep && state.sweep.running) {
    state.sweep.abort('Sweep stopped: disconnected.');
    await waitForTx(500); // let lO0 reach the board before the port closes
  }
  if (state.recording) await stopRecording();

  const safr = state.safr;
  state.safr = null;
  if (safr) {
    try {
      await safr.close();
    } catch (err) {
      logMonitor(`! ${err.message}`, 'err');
    }
  }

  setConnectedUI(false);
  if (!ui.statusLine.classList.contains('error')) setStatus('Disconnected.');
}

// ----------------------------------------------------------------- acquisition

function startTimer() {
  stopTimer();
  state.timer = window.setInterval(tick, state.updateInterval);
}

function stopTimer() {
  if (state.timer !== null) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
}

function resetBuffers() {
  state.x = [];
  state.y = SERIES.map(() => []);
  state.offset = 0;
  state.startTime = performance.now();
  plot.setData(state.x, state.y);
  updateXLimit();
  plot.draw();
  legendValues.forEach((node) => {
    node.textContent = '--';
  });
}

function readWindowField(node, key, min, max) {
  const raw = parseInt(node.value, 10);
  if (Number.isNaN(raw) || raw < min || raw > max) {
    node.value = String(state.saved[key]);
    return state.saved[key];
  }
  state.saved[key] = raw;
  return raw;
}

function updateXLimit() {
  const hours = readWindowField(ui.hoursField, 'hours', 0, 23);
  const minutes = readWindowField(ui.minutesField, 'minutes', 0, 59);
  const seconds = readWindowField(ui.secondsField, 'seconds', 1, 59);

  state.totalSeconds = seconds + minutes * 60 + hours * 3600;
  plot.setXRange(state.offset, state.offset + state.totalSeconds);
}

/** Stride-decimate so very long windows stay cheap to draw. */
function decimate(x, ys, maxPoints) {
  if (x.length <= maxPoints) return [x, ys];
  const stride = Math.ceil(x.length / maxPoints);
  const dx = [];
  const dys = ys.map(() => []);
  for (let i = 0; i < x.length; i += stride) {
    dx.push(x[i]);
    ys.forEach((values, s) => dys[s].push(values[i]));
  }
  // Always keep the newest sample so the trace reaches the right edge.
  const last = x.length - 1;
  if (dx[dx.length - 1] !== x[last]) {
    dx.push(x[last]);
    ys.forEach((values, s) => dys[s].push(values[last]));
  }
  return [dx, dys];
}

function tick() {
  const safr = state.safr;
  if (!safr || !safr.isOpen) return;

  safr.updateInfo();

  const dt = (performance.now() - state.startTime) / 1000;
  const sample = [safr.externTemp2, safr.bboTemp, safr.externTemp1, safr.tecVoltage];

  state.x.push(dt);
  state.y.forEach((values, i) => values.push(sample[i]));

  // Rolling window: hold the left edge at 0 until the window fills, then slide.
  const slid = dt - state.totalSeconds;
  state.offset = state.x[0] >= slid ? state.x[0] : slid;

  let cut = 0;
  while (cut < state.x.length && state.x[cut] < state.offset) cut += 1;
  if (cut > 0) {
    state.x = state.x.slice(cut);
    state.y = state.y.map((values) => values.slice(cut));
  }
  if (state.x.length > MAX_BUFFER_POINTS) {
    const drop = state.x.length - MAX_BUFFER_POINTS;
    state.x = state.x.slice(drop);
    state.y = state.y.map((values) => values.slice(drop));
  }

  updateXLimit();

  if (state.recording) {
    if (dt > state.totalSeconds) {
      // Matches the Python GUI: a run ends once it fills the plot window.
      stopRecording('Recording complete — reached the Max Length window.');
    } else {
      state.pendingRows.push([dt.toFixed(3), ...sample.map((v) => String(v))].join(','));
      flushRows();
    }
  }

  legendValues.forEach((node, i) => {
    node.textContent = Number.isFinite(sample[i]) ? sample[i].toFixed(SERIES[i].digits) : '--';
  });

  const [dx, dys] = decimate(state.x, state.y, MAX_PLOT_POINTS);
  plot.setData(dx, dys);
  plot.draw();
}

// ------------------------------------------------------------------- recording

async function flushRows() {
  if (!state.pendingRows.length || !state.logPath) return;
  const rows = state.pendingRows;
  state.pendingRows = [];
  await host.appendLog(rows);
}

async function startRecording() {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defaultName =
    `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
    `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.csv`;

  const chosen = await host.startLog(defaultName, CSV_HEADER);
  if (!chosen) {
    setStatus('Recording cancelled.');
    return;
  }

  state.logPath = chosen;
  state.pendingRows = [];
  state.recording = true;
  resetBuffers();
  ui.recordButton.textContent = 'Stop';
  ui.recordButton.classList.add('active');
  setStatus(`Recording to ${chosen}`, 'ok');
}

async function stopRecording(message) {
  state.recording = false;
  await flushRows();
  const finished = await host.stopLog();
  state.logPath = null;
  ui.recordButton.textContent = 'Record';
  ui.recordButton.classList.remove('active');
  if (finished) setStatus(message || `Saved ${finished}`, 'ok');
}

// -------------------------------------------------------------------- commands

/** Parse a decimal field into hundredths, as the Python GUI did. */
function toHundredths(node) {
  const value = parseFloat(node.value);
  if (Number.isNaN(value)) return null;
  return Math.trunc(value * 100);
}

function requireLink() {
  if (state.safr && state.safr.isOpen) return true;
  setStatus('Not connected.', 'error');
  return false;
}

ui.refreshPortsButton.addEventListener('click', () => refreshPorts());

ui.connectButton.addEventListener('click', () => {
  if (state.connecting) return;
  if (state.safr) disconnect();
  else connect();
});

ui.queryFirmwareButton.addEventListener('click', () => {
  if (requireLink()) state.safr.getVersion();
});

ui.currentSetField.addEventListener('change', () => {
  if (!requireLink()) return;
  const hundredths = toHundredths(ui.currentSetField);
  if (hundredths === null) return;
  state.safr.setLaserCurrent(hundredths);
  ui.currentSetField.value = '';
  setStatus(`Laser current setpoint sent (lC${hundredths}).`);
});

ui.byfSetpointSetField.addEventListener('change', () => {
  if (!requireLink()) return;
  const hundredths = toHundredths(ui.byfSetpointSetField);
  if (hundredths === null) return;
  state.safr.selectSpecTEC();
  state.safr.setTECTemperature(hundredths);
  ui.byfSetpointSetField.value = '';
  setStatus(`Pr:BYF setpoint sent (tS0, tT${hundredths}).`);
});

ui.bboSetpointSetField.addEventListener('change', () => {
  if (!requireLink()) return;
  const hundredths = toHundredths(ui.bboSetpointSetField);
  if (hundredths === null) return;
  state.safr.selectLaserTEC();
  state.safr.setTECTemperature(hundredths);
  ui.bboSetpointSetField.value = '';
  setStatus(`BBO setpoint sent (tS1, tT${hundredths}).`);
});

ui.laserOnButton.addEventListener('click', () => {
  if (requireLink()) state.safr.laserOutputOn();
});

ui.laserOffButton.addEventListener('click', () => {
  if (!requireLink()) return;
  // Off always wins: during a sweep it stops the sweep (which sends lO0).
  if (state.sweep && state.sweep.running) state.sweep.abort('Sweep stopped with the Off button. Laser off.');
  else state.safr.laserOutputOff();
});

ui.tecDiagnosticFlag.addEventListener('change', () => {
  if (!requireLink()) {
    ui.tecDiagnosticFlag.checked = false;
    return;
  }
  state.safr.setTECDiagnosticMode(ui.tecDiagnosticFlag.checked);
  setStatus(
    ui.tecDiagnosticFlag.checked
      ? 'TEC diagnostic stream enabled (ta5) — TEC voltage now updates.'
      : 'TEC diagnostic stream disabled (ta0).'
  );
});

function sendManual() {
  if (!requireLink()) return;
  const cmd = ui.manualCommandField.value.trim();
  if (!cmd) return;
  state.safr.write(cmd);
  ui.manualCommandField.value = '';
}

ui.manualSendButton.addEventListener('click', sendManual);
ui.manualCommandField.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendManual();
});

[ui.hoursField, ui.minutesField, ui.secondsField].forEach((node) => {
  node.addEventListener('change', () => {
    updateXLimit();
    plot.draw();
  });
});

ui.rateSlider.addEventListener('input', () => {
  state.updateInterval = Number(ui.rateSlider.value);
  ui.rateReadout.textContent = `${state.updateInterval} ms`;
  if (state.timer !== null) startTimer();
});

ui.recordButton.addEventListener('click', () => {
  if (state.recording) stopRecording();
  else startRecording();
});

ui.resetButton.addEventListener('click', () => {
  resetBuffers();
  setStatus('Plot buffers cleared.');
});

ui.monitorClearButton.addEventListener('click', () => {
  ui.monitorLog.replaceChildren();
});

window.addEventListener('beforeunload', () => {
  if (state.sweep && state.sweep.running) state.sweep.abort('Window closed.');
  stopTimer();
  if (state.safr) state.safr.close();
});

// -------------------------------------------------------------------- LI sweep

const SWEEP_FIELDS = () => [ui.sweepStartField, ui.sweepEndField, ui.sweepStepField, ui.sweepHoldField];

function readSweepFields() {
  return {
    startA: parseFloat(ui.sweepStartField.value),
    endA: parseFloat(ui.sweepEndField.value),
    stepA: parseFloat(ui.sweepStepField.value),
    holdS: parseFloat(ui.sweepHoldField.value)
  };
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s} s`;
}

function setSweepStatus(text, kind = '') {
  ui.sweepStatus.textContent = text;
  ui.sweepStatus.className = `sweep-status ${kind}`.trim();
}

/** Idle readout: how many steps and how long, or what is wrong with the fields. */
function describeSweepPlan() {
  if (state.sweep && state.sweep.running) return;
  if (!state.safr) {
    setSweepStatus('Connect to run a sweep.');
    return;
  }
  try {
    const { startA, endA, stepA, holdS } = readSweepFields();
    if (!(holdS > 0)) throw new Error('Hold time must be greater than zero.');
    const levels = window.LISweep.plan({ startA, endA, stepA });
    setSweepStatus(`${levels.length} steps, ${formatDuration(levels.length * holdS)} total`);
    ui.sweepButton.disabled = false;
  } catch (err) {
    setSweepStatus(err.message, 'error');
    ui.sweepButton.disabled = true;
  }
}

/** Lock out controls that would fight the sweep for the current setpoint. */
function setSweepUI(running) {
  const connected = Boolean(state.safr);
  [ui.laserOnButton, ui.currentSetField, ui.manualCommandField, ui.manualSendButton, ...SWEEP_FIELDS()].forEach((node) => {
    node.disabled = running || !connected;
  });
  ui.sweepButton.textContent = running ? 'Abort Sweep' : 'Run LI Sweep';
  ui.sweepButton.classList.toggle('active', running);
  ui.sweepButton.title = running
    ? 'Stops the sweep and turns the laser off'
    : 'Turns the laser on at the start current, steps it every hold period, then turns it off';
}

function showSweepProgress() {
  const sweep = state.sweep;
  if (!sweep || !sweep.running) return;
  const st = sweep.status();
  setSweepStatus(
    `Step ${st.index + 1}/${st.total} · ${st.amps.toFixed(2)} A · ` +
      `${Math.ceil(st.stepRemainingS)} s · ${formatDuration(st.totalRemainingS)} left`,
    'running'
  );
}

function startSweep() {
  if (!requireLink()) return;

  let sweep;
  try {
    sweep = new window.LISweep({
      safr: state.safr,
      ...readSweepFields(),
      onStep: ({ index, total, amps }) => {
        logMonitor(`# LI sweep step ${index + 1}/${total}: ${amps.toFixed(2)} A`, 'tx');
        showSweepProgress();
      },
      onDone: ({ completed, reason }) => {
        window.clearInterval(state.sweepTimer);
        state.sweepTimer = null;
        setSweepUI(false);
        if (completed) {
          setStatus('LI sweep complete. Laser off. You can stop the StarLab recording.', 'ok');
          logMonitor('# LI sweep complete, laser off', 'tx');
        } else {
          setStatus(reason, 'error');
          logMonitor(`# ${reason}`, 'err');
        }
        describeSweepPlan();
      }
    });
  } catch (err) {
    setSweepStatus(err.message, 'error');
    return;
  }

  const first = sweep.levels[0] / 100;
  const last = sweep.levels[sweep.levels.length - 1] / 100;
  const ok = window.confirm(
    `This turns the laser output ON at ${first.toFixed(2)} A, steps it up to ${last.toFixed(2)} A ` +
      `(${sweep.total} steps, ${formatDuration(sweep.durationS)}), then turns it OFF.\n\n` +
      'Check the interlocks, beam path and eye protection, and start the StarLab recording first.\n\nStart the sweep?'
  );
  if (!ok) return;

  state.sweep = sweep;
  state.sweepStartedAt = performance.now();
  setSweepUI(true);
  sweep.start();
  state.sweepTimer = window.setInterval(showSweepProgress, 200);
  setStatus('LI sweep running. Press Abort Sweep or Off to stop.', 'ok');
}

/**
 * If the board reports the output off mid-sweep (interlock, fault, timeout),
 * stop stepping rather than walking the setpoint up with nothing lasing.
 * Ignore the first couple of seconds, while the poll may still show the state
 * from before lO1 was processed.
 */
function watchSweepOutput(outputOn) {
  const sweep = state.sweep;
  if (!sweep || !sweep.running || outputOn) return;
  if (performance.now() - state.sweepStartedAt < 2000) return;
  sweep.abort('Sweep stopped: the board reported the laser output off.');
}

/** Wait (bounded) for queued commands to go out. */
async function waitForTx(maxMs) {
  const safr = state.safr;
  const deadline = performance.now() + maxMs;
  while (safr && safr.transport.pending > 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
}

ui.sweepButton.addEventListener('click', () => {
  if (state.sweep && state.sweep.running) state.sweep.abort('Sweep aborted. Laser off.');
  else startSweep();
});

SWEEP_FIELDS().forEach((node) => node.addEventListener('input', describeSweepPlan));

// ------------------------------------------------------------------- boot-up

ui.rateReadout.textContent = `${state.updateInterval} ms`;
setConnectedUI(false);
resetBuffers();

refreshPorts(true).then(() => {
  if (state.ports.length) setStatus('Select a port and connect.');
});

ui.portSelect.addEventListener('change', () => {
  ui.portSelect.title = ui.portSelect.selectedOptions[0]
    ? ui.portSelect.selectedOptions[0].textContent
    : '';
});

host.version().then((version) => {
  document.title = `SAFR Utility v${version}`;
});
