const {
  app, BrowserWindow, ipcMain, Tray, Menu, Notification,
  dialog, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

const iconPath = path.join(__dirname, 'assets', 'icon.png');
const userData = app.getPath('userData');
const boardFile = path.join(userData, 'board.json');
const settingsFile = path.join(userData, 'settings.json');
const notifiedFile = path.join(userData, 'notified.json');
const imagesDir = path.join(userData, 'images');

let win = null;
let tray = null;
let currentMode = 'top';
let saveBoundsTimer = null;

// ---------- storage helpers ----------
function ensureDirs() {
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('writeJson', e); }
}

// ---------- window ----------
function createWindow() {
  const settings = readJson(settingsFile, {});
  const b = settings.bounds;
  const bounds = b && b.width > 100 && b.height > 100
    ? b
    : { x: 120, y: 120, width: 340, height: 480 };
  currentMode = settings.mode === 'desktop' ? 'desktop' : 'top';

  win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    minWidth: 240, minHeight: 200,
    frame: false,
    transparent: true,
    resizable: true,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    applyMode(currentMode, true);
  });
  win.on('closed', () => { win = null; });
  win.on('resize', scheduleSaveBounds);
  win.on('move', scheduleSaveBounds);
}
function scheduleSaveBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const settings = readJson(settingsFile, {});
    settings.bounds = win.getBounds();
    writeJson(settingsFile, settings);
  }, 400);
}

// ---------- window layer (top / desktop) ----------
function runDesktopLayer(attach) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed() || process.platform !== 'win32') return resolve();
    const handle = win.getNativeWindowHandle();
    const hwnd = handle.length === 8
      ? handle.readBigInt64LE(0).toString()
      : handle.readInt32LE(0).toString();
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'desktop-layer.ps1'),
      '-Hwnd', hwnd, '-Action', attach ? 'attach' : 'detach',
    ], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) console.error('[desktop-layer]', err.message, stderr);
      else console.log('[desktop-layer]', stdout.trim());
      resolve();
    });
  });
}
async function applyMode(mode, initial = false) {
  if (!win || win.isDestroyed()) return mode;
  currentMode = mode;
  if (mode === 'desktop') {
    win.setAlwaysOnTop(false);
    await runDesktopLayer(true);
  } else {
    await runDesktopLayer(false);
    win.setAlwaysOnTop(true, 'floating');
    win.show();
  }
  const settings = readJson(settingsFile, {});
  settings.mode = mode;
  writeJson(settingsFile, settings);
  updateTrayMenu();
  if (!initial) win.webContents.send('mode-changed', mode);
  return mode;
}

// ---------- tray ----------
function createTray() {
  tray = new Tray(iconPath);
  tray.setToolTip('桌面看板');
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
  });
  updateTrayMenu();
}
function updateTrayMenu() {
  if (!tray) return;
  const login = app.getLoginItemSettings();
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏看板', click: () => {
      if (!win) return;
      if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
    } },
    { label: currentMode === 'top' ? '切换为：贴桌面层（不挡窗口）' : '切换为：窗口置顶',
      click: () => applyMode(currentMode === 'top' ? 'desktop' : 'top') },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: login.openAtLogin,
      click: () => app.setLoginItemSettings({ openAtLogin: !login.openAtLogin }) },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ---------- notification ----------
function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: iconPath }).show();
}
function checkDeadlines() {
  const board = readJson(boardFile, []);
  const notified = readJson(notifiedFile, {});
  const now = Date.now();
  let changed = false;
  for (const c of board) {
    if (c.done || !c.due) continue;
    const due = new Date(c.due).getTime();
    if (isNaN(due)) continue;
    const diff = due - now;
    const title = (c.text || '待办').replace(/\s+/g, ' ').slice(0, 40) || '待办';
    if (diff <= 0 && !notified[c.id]) {
      notify('⏰ DDL 到了', title);
      notified[c.id] = true; changed = true;
    } else if (diff > 0 && diff <= 10 * 60 * 1000 && !notified['soon-' + c.id]) {
      notify('⏳ 10 分钟内截止', title);
      notified['soon-' + c.id] = true; changed = true;
    }
  }
  if (changed) writeJson(notifiedFile, notified);
}

// ---------- OCR ----------
function runOcr(localPath) {
  return new Promise((resolve) => {
    const outFile = path.join(app.getPath('userData'), 'ocr-result.json');
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'ocr.ps1'),
      '-ImagePath', localPath,
      '-OutFile', outFile,
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const finish = (text) => {
        try {
          const obj = JSON.parse(text);
          resolve({ ok: true, text: obj.text || '', lines: obj.lines || [], words: obj.words || [], dates: obj.dates || [] });
        } catch {
          resolve({ ok: true, text: text, lines: text.split(/\r?\n/).filter(Boolean), words: [], dates: [] });
        }
      };
      if (err) {
        console.error('[ocr]', err.message, stderr);
        resolve({ ok: false, text: '', lines: [], error: err.message });
      } else {
        // Read the UTF-8 file written by PowerShell — never trust stdout encoding.
        try {
          finish(fs.readFileSync(outFile, 'utf8'));
        } catch (e) {
          console.error('[ocr] read outFile', e.message, stdout, stderr);
          resolve({ ok: false, text: '', lines: [], error: e.message });
        }
      }
    });
  });
}

// ---------- IPC ----------
ipcMain.handle('get-board', () => readJson(boardFile, []));
ipcMain.handle('save-board', (_, board) => {
  const old = readJson(boardFile, []);
  const oldMap = new Map(old.map(c => [c.id, c.due]));
  const notified = readJson(notifiedFile, {});
  for (const c of board) {
    if (oldMap.get(c.id) !== c.due) {
      delete notified[c.id];
      delete notified['soon-' + c.id];
    }
  }
  writeJson(notifiedFile, notified);
  writeJson(boardFile, board);
});
ipcMain.handle('get-mode', () => currentMode);
ipcMain.handle('set-mode', (_, mode) => applyMode(mode));

function saveImageBuffer(buffer, ext) {
  const name = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext;
  fs.writeFileSync(path.join(imagesDir, name), buffer);
  return pathToFileURL(path.join(imagesDir, name)).href;
}
ipcMain.handle('select-image', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择一张图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  });
  if (canceled || !filePaths.length) return [];
  return filePaths.map(src => {
    const ext = (path.extname(src).slice(1) || 'png').toLowerCase();
    return saveImageBuffer(fs.readFileSync(src), ext);
  });
});
// drag & drop: renderer passes the dropped file's local path, we copy it into userData
ipcMain.handle('import-image-path', (_, srcPath) => {
  try {
    const ext = (path.extname(srcPath).slice(1) || 'png').toLowerCase();
    return { ok: true, url: saveImageBuffer(fs.readFileSync(srcPath), ext) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('ocr-image', async (_, fileUrl) => {
  let localPath;
  try { localPath = fileURLToPath(fileUrl); } catch { return { ok: false, text: '', error: 'bad path' }; }
  return runOcr(localPath);
});

ipcMain.on('move-by', (_, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  win.setBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height });
});
ipcMain.on('resize-to', (_, w, h) => {
  if (!win || win.isDestroyed()) return;
  win.setBounds({
    ...win.getBounds(),
    width: Math.max(240, Math.round(w)),
    height: Math.max(200, Math.round(h)),
  });
});
ipcMain.on('hide-window', () => win && win.hide());
ipcMain.on('quit-app', () => app.quit());

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
  app.whenReady().then(() => {
    ensureDirs();
    createWindow();
    createTray();
    checkDeadlines();
    setInterval(checkDeadlines, 30 * 1000);
  });
  app.on('window-all-closed', () => { /* keep running in tray */ });
}
