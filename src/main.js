'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { listSerialPorts } = require('./ports');

/**
 * The renderer talks to the board with the Web Serial API (navigator.serial).
 * Chromium routes every navigator.serial.requestPort() call through the main
 * process 'select-serial-port' session event, which is the only place a
 * Chromium port handle can be obtained. So the main process:
 *
 *   1. fills the dropdown from an OS-level port scan (see ports.js), which
 *      needs no user gesture and so works at startup, and
 *   2. answers each requestPort() with whichever port the renderer asked for,
 *      matched on its OS name (COM4, /dev/ttyUSB0).
 */
let mainWindow = null;
let chromiumPorts = [];
let desiredPortId = null;

/** Open CSV log stream, owned by the main process so writes survive re-renders. */
let logStream = null;
let logPath = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#14171c',
    title: 'SAFR Utility',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep timers running at full rate while the window is minimised or
      // behind another app (e.g. StarLab during an LI sweep). Chromium otherwise
      // throttles background timers, which would stretch the sweep's steps.
      backgroundThrottling: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open any external link in the real browser rather than inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const session = mainWindow.webContents.session;

  session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();

    chromiumPorts = portList.map((p) => ({
      portId: p.portId,
      portName: p.portName || '',
      displayName: p.displayName || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
      serialNumber: p.serialNumber || ''
    }));

    if (desiredPortId === null) {
      callback(''); // no port requested — cancel the picker
      return;
    }

    const wanted = desiredPortId;
    desiredPortId = null;
    const match = portList.find((p) => p.portId === wanted || p.portName === wanted);
    callback(match ? match.portId : '');
  });

  // The user picks the port in-app, so grant serial access without a second prompt.
  session.setPermissionCheckHandler((webContents, permission) => permission === 'serial');
  session.setDevicePermissionHandler((details) => details.deviceType === 'serial');

  mainWindow.on('closed', () => {
    closeLog();
    mainWindow = null;
  });
}

function closeLog() {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  logPath = null;
}

ipcMain.handle('serial:listPorts', () => listSerialPorts(chromiumPorts));

ipcMain.handle('serial:setDesiredPort', (_event, portId) => {
  desiredPortId = portId === undefined ? null : portId;
  return true;
});

ipcMain.handle('log:start', async (_event, { defaultName, header }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save recording as',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return null;

  closeLog();
  logPath = result.filePath;
  logStream = fs.createWriteStream(logPath, { flags: 'w' });
  if (header) logStream.write(header + '\n');
  return logPath;
});

ipcMain.handle('log:append', (_event, rows) => {
  if (!logStream || !rows || !rows.length) return false;
  logStream.write(rows.join('\n') + '\n');
  return true;
});

ipcMain.handle('log:stop', () => {
  const finished = logPath;
  closeLog();
  return finished;
});

ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  closeLog();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
