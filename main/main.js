/**
 * StudyBuddy — main process
 */
const { app, BrowserWindow, screen, Tray, Menu, ipcMain, nativeImage, dialog, } = require('electron');
const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env')
});

const Store = require('electron-store').default;

const store = new Store({ name: 'settings' });


// Separate store for app data (tasks, sessions, etc.)
const data = new Store({ name: 'data' }); // %APPDATA%/StudyBuddy/data.json
function loadTasks() { return data.get('tasks') || []; }
function saveTasks(tasks) { data.set('tasks', tasks); }
function nextOrder(tasks) { return tasks.reduce((m, t) => Math.max(m, t.order || 0), 0) + 1; }
function makeId() { return Math.random().toString(36).slice(2); }

const BASE = 32, SCALE = 4;
const WIDTH = BASE * SCALE;
const HEIGHT = BASE * SCALE;
const PADDING = 16;
const ICON = path.join(__dirname, '../assets/icons/buddy256.ico');

let buddyWin, tray, dashWin;

function getDefaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + PADDING, y: wa.y + wa.height - HEIGHT - PADDING };
}

function createBuddyWindow() {
  const saved = store.get('buddy.position');
  const pos = saved || getDefaultPos();

  buddyWin = new BrowserWindow({
    icon: ICON,
    width: WIDTH,
    height: HEIGHT,
    show: true,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  buddyWin.loadFile(path.join(__dirname, '../buddy-ui/index.html'));

  buddyWin.webContents.openDevTools({ mode: 'detach' });

  buddyWin.on('move', () => {
    const [x, y] = buddyWin.getPosition();
    store.set('buddy.position', { x, y });
  });
}

function createDashboardWindow() {
  dashWin = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 420,
    minHeight: 480,
    title: 'StudyBuddy — Dashboard',
    show: true,
    icon: ICON,
    webPreferences: {
      // >>>the dashboard needs the same preload to get window.electronAPI
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  dashWin.loadFile(path.join(__dirname, '../dashboard-ui/index.html'));
  dashWin.once('ready-to-show', () => { dashWin.center(); dashWin.show(); });
  dashWin.on('closed', () => { dashWin = null; });
}

function createTray() {
  const trayIcon = nativeImage
    .createFromPath(path.join(__dirname, '../assets/icons/buddy256.png'))
    .resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('StudyBuddy');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Buddy', click: () => buddyWin?.show() },
    { label: 'Hide Buddy', click: () => buddyWin?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

// ---------- Google Calendar OAuth helpers (paste into main/main.js) ----------
require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const { shell } = require('electron'); // used to open the browser for consent

const GCLIENT_ID = process.env.GCLIENT_ID;
console.log('GCLIENT_ID from env:', process.env.GCLIENT_ID)
const GCLIENT_SECRET = process.env.GCLIENT_SECRET || ''; // desktop apps often have no secret
const OAUTH_PORT = Number(process.env.OAUTH_PORT || 42813);
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}/oauth2callback`;
const GCAL_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

// In-memory OAuth2 client object reference
let oauth2Client = null;

// Create (or return existing) OAuth2 client
function getOAuthClient() {
  if (!oauth2Client) {
    oauth2Client = new google.auth.OAuth2(
      GCLIENT_ID,
      GCLIENT_SECRET,
      REDIRECT_URI
    );

    // If we already saved tokens previously, load them into the client
    const tok = data.get('gcal.tokens'); // 'data' Store must exist earlier in your file
    if (tok) oauth2Client.setCredentials(tok);
  }
  return oauth2Client;
}

/**
 * Start the "connect" OAuth flow:
 *  - Generate auth URL
 *  - Open default browser (shell.openExternal)
 *  - Start a tiny local HTTP server to receive the redirect with 'code'
 *  - Exchange code for tokens and store them with electron-store (data)
 */
async function startGoogleConnectFlow() {
  if (!GCLIENT_ID) throw new Error('Missing GCLIENT_ID in env');

  const client = getOAuthClient();

  // request offline access so we get a refresh_token
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: GCAL_SCOPES,
    prompt: 'consent' // force consent so we get a refresh token on first auth
  });

  // open the browser for the user to sign in
  shell.openExternal(authUrl);

  // Wait for the redirect; return a promise that resolves once we have tokens
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url) return;
        const url = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404); res.end('Not found'); return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400); res.end('No code'); return;
        }

        console.log('[MAIN] Received OAuth code:', code.slice(0,10) + '...');

        // exchange code for tokens
        const { tokens } = await client.getToken(code);
        console.log('[MAIN] getToken result:', tokens);

        client.setCredentials(tokens);

        // persist tokens to electron-store (so user stays logged in)
        data.set('gcal.tokens', tokens);

        // respond with a tiny success HTML page (user sees this in browser)
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<html><body><h2>Connected — you can close this window</h2></body></html>');

        server.close();
        resolve(tokens);
      } catch (err) {
        console.error('[MAIN] OAuth callback error:', err && err.response && err.response.data ? err.response.data : err );
        try { res.writeHead(500); res.end('Auth error'); } catch(e){}
        server.close();
        reject(err);
      }
    });

    server.on('error', (err) => {
      console.error('[MAIN] Local OAuth server error: ', err);
      reject(err);
    });

    server.listen(OAUTH_PORT, '127.0.0.1');
  });
}

/**
 * Helper to create an event in the user's primary calendar.
 * Accepts an "event" object with the fields normally accepted by Google Calendar API.
 */
async function googleAddEvent(eventResource) {
  const client = getOAuthClient();

  // Ensure we have tokens — if not, user must connect first
  if (!client.credentials || !client.credentials.access_token) {
    throw new Error('Not connected to Google Calendar (no tokens)');
  }

  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.events.insert({
    calendarId: 'primary',
    resource: eventResource
  });
  return res.data; // contains htmlLink, id, etc.
}

// ---------- IPC handlers ----------
// Called by renderer to start OAuth flow (connect account)
ipcMain.handle('gcal:connect', async () => {
  console.log('[MAIN] gcal:connect called');
  try {
    const tokens = await startGoogleConnectFlow();
    console.log('[MAIN] gcal:connect success, tokens:', tokens);
    return { ok: true, tokens };
  } catch (err) {
    console.error('[MAIN] gcal:connect ERROR:', err);
    return { ok: false, error: String(err.message || err) };
  }
});

// Called by renderer to add an event. Expects eventResource {summary, start:{dateTime}, end:{dateTime}, ...}
ipcMain.handle('gcal:addEvent', async (_evt, eventResource) => {
  try {
    const created = await googleAddEvent(eventResource);
    return { ok: true, event: created };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});


app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.studybuddy.app');

  console.log('creating buddy window...');
  createBuddyWindow();

  createDashboardWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createBuddyWindow();
  });
});

app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin') e.preventDefault();
});

// Buddy → Dashboard toggle
ipcMain.on('toggle-dashboard', () => {
  if (!dashWin) { createDashboardWindow(); return; }
  if (dashWin.isVisible()) dashWin.hide();
  else { if (dashWin.isMinimized()) dashWin.restore(); dashWin.show(); dashWin.focus(); }
});

/* ===== Tasks IPC (persist with electron-store) ===== */
ipcMain.handle('tasks:list', () => loadTasks());

ipcMain.handle('tasks:add', (_evt, task) => {
  const tasks = loadTasks();
  const t = {
    id: makeId(),
    title: task.title || '',
    due: task.due || '',
    priority: task.priority || '',
    done: false,
    createdAt: Date.now(),
    completedAt: null,
    order: nextOrder(tasks)
  };
  tasks.push(t);
  saveTasks(tasks);
  return tasks;
});

ipcMain.handle('tasks:update', (_evt, patch) => {
  const tasks = loadTasks();
  const i = tasks.findIndex(x => x.id === patch.id);
  if (i >= 0) {
    const wasDone = !!tasks[i].done;
    const willBeDone = patch.hasOwnProperty('done') ? !!patch.done : wasDone;
    tasks[i] = { ...tasks[i], ...patch, completedAt: willBeDone ? (tasks[i].completedAt || Date.now()) : null };
    saveTasks(tasks);
  }
  return tasks;
});

ipcMain.handle('tasks:delete', (_evt, id) => {
  const tasks = loadTasks().filter(t => t.id !== id);
  saveTasks(tasks);
  return tasks;
});

ipcMain.handle('tasks:reorder', (_evt, ids) => {
  const tasks = loadTasks();
  const map = new Map(ids.map((id, idx) => [id, idx + 1]));
  tasks.forEach(t => { if (map.has(t.id)) t.order = map.get(t.id); });
  saveTasks(tasks);
  return tasks;
});


// ===== Timer session history (persisted) =====
ipcMain.handle('timer:sessions:list', () => {
  return data.get('sessions') || [];
});

ipcMain.handle('timer:sessions:add', (_evt, entry) => {
  const sessions = data.get('sessions') || [];
  // entry: { type: 'focus'|'break-short'|'break-long', startTs, endTs, seconds, completed }
  sessions.push({ id: makeId(), ...entry });
  data.set('sessions', sessions);
  return sessions;
});





const axios = require('axios');
const AI_BASE_URL = 'http://127.0.0.1:8000';

async function postToAI(path, body) {
  const res = await axios.post(`${AI_BASE_URL}${path}`, body, { timeout: 60000 });
  return res.data;
}

ipcMain.handle('ai:quiz', async (_evt, { topic, difficulty, numQuestions }) => {
  try {
    const data = await postToAI('/quiz', {
      topic,
      difficulty,
      num_questions: numQuestions ?? 5,
    });
    return { ok: true, data };
  } catch (err) {
    console.error('ai:quiz error', err);
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('ai:doubt', async (_evt, { question, lastAnswer }) => {
  try {
    const data = await postToAI('/doubt', { question, last_answer: lastAnswer || '' });
    return { ok: true, data };
  } catch (err) {
    console.error('ai:doubt error', err);
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('ai:summarize', async (_evt, { mode }) => {
  try {
    const data = await postToAI('/summarize', { mode: mode || 'Detailed' });
    return { ok: true, data };
  } catch (err) {
    console.error('ai:summarize error', err);
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('ai:ingest', async () => {
  try {
    const res = await dialog.showOpenDialog({
      title: 'Select PDF notes',
      properties: ['openFile'],
      filters: [{ name: 'PDFs', extensions: ['pdf'] }],
    });

    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' };
    }

    const pdfPath = res.filePaths[0];

    const data = await postToAI('/ingest', { path: pdfPath });

    return { ok: true, data };
  } catch (err) {
    console.error('[MAIN] ai:ingest error', err);
    return { ok: false, error: String(err.message || err) };
  }
});



