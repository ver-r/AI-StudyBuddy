// dashboard-ui/app.js
const routes = ['today', 'tasks', 'plan', 'settings', 'ai','emotion'];

const state = {
  // Timer config (minutes)
  timer: { focus: 25, short: 5, long: 15, every: 4, status: 'idle', bestStreak: 0 },

  // Derived/stats
  stats: { sessions: 0, minutes: 0, streak: 0},

  integrations: {
    gcal: { connected: false, email: null }
  },

 ai: { 
    pdfs: [],
    lastAnswer: '',
    selectedPdf: null,
    quizHistory: [],           // <--- add this
    quiz: {
      questions: [],
      currentIndex: 0,
      answers: [],
      inProgress: false,
      finished: false,
      report: null
    }
  },

  emotion: {
    history: [],
    allow: false,              // consent to use webcam
    lastAutoCheckTs: 0,        // last auto-check timestamp
    isRunning: false,          // a check is currently running
    currentSessionSamples: []  // samples for the active focus session
  },


  // Tasks
  tasks: [],
  taskSort: 'manual',   // 'manual' | 'priority' | 'due'
  taskFilter: 'all',    // 'all' | 'active' | 'done' | 'today' | 'overdue'

  // Sessions history (filled from store)
  sessions: []
};

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/*==================== Theme ====================*/
function saveTheme(mode){ try{localStorage.setItem('sb.theme',mode);}catch{} }
function loadTheme(){ try{return localStorage.getItem('sb.theme')||'dark';}catch{return 'dark';} }
function applyTheme(mode){
  const resolved = mode==='system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  $('#themeToggle') && ($('#themeToggle').textContent = resolved==='light' ? '🌙' : '☀️');
  $('#setTheme') && ($('#setTheme').value = mode);
}
function wireThemeToggle(){
  $('#themeToggle')?.addEventListener('click', ()=>{
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur==='dark' ? 'light' : 'dark';
    applyTheme(next); saveTheme(next);
  });
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', ()=>{ if (loadTheme()==='system') applyTheme('system'); });
  } catch {}
}

/*==================== Tiny helpers ====================*/
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function escapeHtml(s=''){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }


function showToast(message, kind = 'info') {
  let box = document.getElementById('sbToastContainer');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sbToastContainer';
    Object.assign(box.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      zIndex: 9999
    });
    document.body.appendChild(box);
  }

  const toast = document.createElement('div');
  toast.textContent = message;
  Object.assign(toast.style, {
    padding: '8px 12px',
    borderRadius: '8px',
    fontSize: '13px',
    background: kind === 'warn'
      ? 'rgba(255, 149, 128, 0.12)'
      : 'rgba(129, 230, 217, 0.12)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    opacity: '0',
    transform: 'translateY(6px)',
    transition: 'opacity .18s ease, transform .18s ease'
  });

  box.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    setTimeout(() => toast.remove(), 200);
  }, 3500);
}




function loadIntegrations(){
  try {
    const raw = localStorage.getItem('sb.integrations');
    if (raw) state.integrations = JSON.parse(raw);
  } catch {}
}
function saveIntegrations(){
  try { localStorage.setItem('sb.integrations', JSON.stringify(state.integrations)); } catch {}
}

function loadEmotionHistory() {
  try {
    const raw = localStorage.getItem('sb.emotionHistory');
    if (raw) state.emotion.history = JSON.parse(raw);
  } catch {
    state.emotion.history = [];
  }
}

function saveEmotionHistory() {
  try {
    localStorage.setItem('sb.emotionHistory', JSON.stringify(state.emotion.history));
  } catch {}
}

function loadEmotionPrefs() {
  try {
    const raw = localStorage.getItem('sb.emotionPrefs');
    if (raw) {
      const o = JSON.parse(raw);
      state.emotion.allow = !!o.allow;
    }
  } catch {}
}

function saveEmotionPrefs() {
  try {
    localStorage.setItem('sb.emotionPrefs', JSON.stringify({
      allow: !!state.emotion.allow
    }));
  } catch {}
}

function renderEmotionHistory() {
  const list = $('#emotionHistory');
  if (!list) return;

  const items = state.emotion.history || [];
  if (!items.length) {
    list.innerHTML = '<li class="empty">No history yet.</li>';
    return;
  }

  list.innerHTML = '';
  for (const entry of items) {
    const d = new Date(entry.ts || Date.now());
    const when = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="card" style="padding:10px; display:flex; flex-direction:column; gap:4px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <strong>${entry.classification || 'Unknown'}</strong>
          <span style="margin-left:6px;">${(entry.score ?? 0).toFixed(2)}/10</span>
          ${entry.emotion ? `<span class="chip" style="margin-left:auto;">${entry.emotion}</span>` : ''}
        </div>
        <div class="muted" style="font-size:12px;">${when}</div>
      </div>
    `;
    list.appendChild(li);
  }
}


// simple notification helper (renderer Notifications)
function emotionNotify(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {
    // ignore
  }
}


const EMOTION_AUTO_INTERVAL_MS = 2 * 60_000; // 2 minutes

async function runEmotionCheckAuto() {
  if (!state.emotion.allow) return;
  if (state.emotion.isRunning) return;

  state.emotion.isRunning = true;
  try {
    const res = await window.electronAPI.ai.attentive();
    console.log('ai:attentive (auto) result', res);

    if (!res || !res.ok || res.data?.ok === false) {
      const msg = res?.error || res?.data?.error || 'Attentiveness check failed.';
      console.warn('Auto check failed:', msg);
      return;
    }

    const payload = res.data || {};
    const score = typeof payload.score === 'number'
      ? payload.score
      : (payload.normalized_score ?? 0);
    const classification = payload.classification || 'Unknown';
    const emotion = (payload.details && payload.details.emotion) || payload.emotion || '';

    const entry = {
      ts: Date.now(),
      score,
      classification,
      emotion,
      source: 'auto'
    };

    state.emotion.history.unshift(entry);
    state.emotion.history = state.emotion.history.slice(0, 50);
    saveEmotionHistory();
    renderEmotionHistory();

    if (TIMER.phase === 'focus') {
      state.emotion.currentSessionSamples.push({ ts: entry.ts, score, classification, emotion });
    }

    const isDistracted = (classification || '').toLowerCase() === 'distracted' || score < 6;
    if (isDistracted) {
      emotionNotify('StudyBuddy', 'You seem a bit distracted during this session.');
    } else {
      emotionNotify('StudyBuddy', 'Focus check: you’re doing great.');
    }
  } catch (err) {
    console.error('ai:attentive (auto) error', err);
  } finally {
    state.emotion.isRunning = false;
  }
}

function maybeAutoEmotionCheck() {
  if (!state.emotion.allow) return;
  if (TIMER.phase !== 'focus') return;
  const now = Date.now();
  if (now - (state.emotion.lastAutoCheckTs || 0) < EMOTION_AUTO_INTERVAL_MS) return;

  state.emotion.lastAutoCheckTs = now;
  // fire and forget
  runEmotionCheckAuto();
}



/*==================== AI helpers ====================*/
/*==================== AI helpers ====================*/
function loadAIPdfs() {
  try {
    const raw = localStorage.getItem('sb.aiPdfs');
    state.ai.pdfs = raw ? JSON.parse(raw) : [];
  } catch {
    state.ai.pdfs = [];
  }
}

function saveAIPdfs() {
  try {
    localStorage.setItem('sb.aiPdfs', JSON.stringify(state.ai.pdfs));
  } catch {}
}

function renderAIPdfList() {
  const list = $('#aiPdfList');
  if (!list) return;

  const pdfs = state.ai.pdfs || [];

  if (!pdfs.length) {
    list.innerHTML = '<li class="empty">No PDFs added yet. Click “Add PDF notes”.</li>';
    return;
  }

  list.innerHTML = '';
  for (const item of pdfs) {
    const li = document.createElement('li');
    li.style.cursor = 'pointer';

    const isSelected = state.ai.selectedPdf && state.ai.selectedPdf.path === item.path;

    li.innerHTML = `
      <div style="
        display:flex;
        align-items:center;
        gap:8px;
        padding:6px 8px;
        border-radius:8px;
        ${isSelected ? 'background: rgba(139,124,251,0.15);' : ''}
      ">
        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${escapeHtml(item.name || item.path)}
        </span>
        <span class="chip">${item.pages ?? '?'} pages</span>
      </div>
    `;

    li.addEventListener('click', () => {
      state.ai.selectedPdf = item;
      renderAIPdfList();  // re-render to update highlight
    });

    list.appendChild(li);
  }
}


function getQuizState() {
  if (!state.ai.quiz) {
    state.ai.quiz = { questions: [], index: 0, answers: [] };
  }
  return state.ai.quiz;
}

function saveQuizHistory() {
  try {
    localStorage.setItem('sb.quizHistory', JSON.stringify(state.ai.quizHistory || []));
  } catch {}
}

function renderQuizQuestion(resultBox, statusLabel) {
  const quiz = getQuizState();
  const total = quiz.questions.length;
  const i = quiz.index;
  const q = quiz.questions[i];

  if (!q) {
    resultBox.textContent = 'No question to show.';
    return;
  }

  statusLabel.textContent = `Question ${i + 1} of ${total}`;

  resultBox.innerHTML = `
    <div style="margin-bottom:8px;">
      <strong>Question ${i + 1} of ${total}</strong>
    </div>
    <div style="margin-bottom:12px;">${escapeHtml(q.question)}</div>
    <form id="aiQuizForm">
      ${['a','b','c','d'].map(l => `
        <label style="display:block; margin:4px 0;">
          <input type="radio" name="opt" value="${l}"> ${l}) ${escapeHtml(q[l] || '')}
        </label>
      `).join('')}
    </form>
    <button class="btn small" id="aiQuizSubmit">Submit</button>
    <div id="aiQuizFeedback" class="muted" style="margin-top:8px;"></div>
  `;

  const submitBtn = $('#aiQuizSubmit');
  const feedback = $('#aiQuizFeedback');

  submitBtn.onclick = () => {
    const checked = resultBox.querySelector('input[name="opt"]:checked');
    if (!checked) {
      feedback.textContent = 'Choose an option first.';
      return;
    }

    const choice = checked.value;
    const correct = String(q.correct || '').toLowerCase();
    const isCorrect = choice === correct;

    quiz.answers[i] = { choice, correct, isCorrect };

    feedback.textContent = isCorrect
      ? 'Correct! 🎉'
      : `Incorrect. Correct answer is ${correct.toUpperCase()}.`;

    // move to next / finish
    if (i < total - 1) {
      submitBtn.textContent = 'Next question';
      submitBtn.onclick = () => {
        quiz.index++;
        renderQuizQuestion(resultBox, statusLabel);
      };
    } else {
      submitBtn.textContent = 'View score';
      submitBtn.onclick = () => renderQuizSummary(resultBox, statusLabel);
    }
  };
}

function renderQuizSummary(resultBox, statusLabel) {
  const quiz = getQuizState();
  const qs = quiz.questions;
  const ans = quiz.answers;

  const total = qs.length;
  const score = ans.filter(a => a && a.isCorrect).length;

  statusLabel.textContent = `Score: ${score} / ${total}`;

  // store in history
  state.ai.quizHistory.push({
    ts: Date.now(),
    total,
    score
  });
  saveQuizHistory();

  const lines = [];
  lines.push(`You scored ${score} out of ${total}.\n`);
  qs.forEach((q, i) => {
    const a = ans[i] || {};
    lines.push(`${i + 1}. ${q.question}`);
    lines.push(`   Your answer:   ${a.choice ? a.choice.toUpperCase() : '-'}  (${a.choice ? q[a.choice] : ''})`);
    lines.push(`   Correct answer: ${String(q.correct).toUpperCase()} (${q[q.correct]})`);
    lines.push(a.isCorrect ? '   ✅ Correct' : '   ❌ Incorrect');
    lines.push('');
  });

  resultBox.textContent = lines.join('\n');
}


function renderGcalUI(){
  const stat = $('#gcalStatus'), btnC = $('#gcalConnect'), btnD = $('#gcalDisconnect');
  if (!stat || !btnC || !btnD) return;
  const gc = state.integrations.gcal;
  if (gc.connected) {
    stat.textContent = gc.email ? `Connected as ${gc.email}` : 'Connected';
    btnC.style.display = 'none';
    btnD.style.display = '';
  } else {
    stat.textContent = 'Not connected';
    btnC.style.display = '';
    btnD.style.display = 'none';
  }
}

function wireGcalUI(){
  $('#gcalConnect')?.addEventListener('click', async ()=>{
    console.log('[Rendered] Google Connect Clicked.');

    try {
      const res = await window.electronAPI.gcalConnect();
      console.log('gcal:connect result:', res);

      if (!res.ok) {
        alert('Google Calendar connect failed: \n' + res.error);
        return;
      }

      state.integrations.gcal = { connected: true, email: null }
      saveIntegrations();
      renderGcalUI();

      alert('Google Calendar connected successfully!');
    } catch (err) {
      console.error(err);
      alert('Connection failed: ' + err);
    }
  });

  $('#gcalDisconnect')?.addEventListener('click', ()=>{
    state.integrations.gcal = { connected: false, email: null };
    saveIntegrations();
    renderGcalUI();
  });
}


// Create a Google Calendar event using the main process IPC
async function createGcalEvent(dateStr, timeStr, durationMin, summary, note) {
  // Must be connected
  if (!state.integrations.gcal?.connected) {
    alert('Connect Google Calendar in Settings first.');
    return;
  }

  // Basic validation
  if (!dateStr || !timeStr || !durationMin) {
    alert('Please fill date, time, and duration.');
    return;
  }

  const date = parseDateISO(dateStr);
  const [hh, mm] = (timeStr || '').split(':').map(Number);
  const dur = Number(durationMin);

  if (!date || isNaN(hh) || isNaN(mm) || !Number.isFinite(dur) || dur <= 0) {
    alert('Invalid date/time/duration.');
    return;
  }

  // Build start/end datetimes in local timezone
  date.setHours(hh, mm, 0, 0);
  const start = date;
  const end = new Date(start.getTime() + dur * 60_000);

  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Kolkata';

  const eventResource = {
    summary: summary || 'Study session',
    description: note ? `StudyBuddy: ${note}` : 'Created from StudyBuddy',
    start: {
      dateTime: start.toISOString(),
      timeZone: tz
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: tz
    }
  };

  try {
    const res = await window.electronAPI.gcalAddEvent(eventResource);
    console.log('[Renderer] gcalAddEvent result:', res);
    if (!res.ok) {
      alert('Failed to add to Google Calendar:\n' + res.error);
    } else {
      alert('Added to Google Calendar ✔');
    }
  } catch (err) {
    console.error('[Renderer] gcalAddEvent error:', err);
    alert('Error while talking to Google Calendar:\n' + err);
  }
}


// Parse 'YYYY-MM-DD' as LOCAL date (avoid timezone off-by-one), else fall back to Date()
function parseDateISO(s){
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    return new Date(y, mo - 1, d);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function startOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }
function isTodayDate(d){ const t = new Date(); return d && startOfDay(d).getTime()===startOfDay(t).getTime(); }
function isSameDay(a,b){ const A=startOfDay(new Date(a)), B=startOfDay(new Date(b)); return A.getTime()===B.getTime(); }

/* === Persist timer settings (localStorage for now) === */
function loadTimerPrefs() {
  try {
    const raw = localStorage.getItem('sb.timer');
    const o = raw ? JSON.parse(raw) : {};
    const sane = { focus: 25, short: 5, long: 15, every: 4, ...o };
    state.timer = { ...state.timer, ...sane };
  } catch {}
}
function saveTimerPrefs() {
  try {
    localStorage.setItem('sb.timer', JSON.stringify({
      focus: state.timer.focus,
      short: state.timer.short,
      long:  state.timer.long,
      every: state.timer.every
    }));
  } catch {}
}

/*==================== Header / Nav ====================*/
function setDate(){
  const d=new Date();
  $('#todayDate') && ($('#todayDate').textContent =
    d.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'}));
}
function showRoute(name){
  $$('.route').forEach(sec=>sec.classList.remove('is-visible'));
  $(`#route-${name}`)?.classList.add('is-visible');
  $$('.nav-item').forEach(b=>b.classList.remove('is-active'));
  $(`.nav-item[data-route="${name}"]`)?.classList.add('is-active');
  if (name === 'analytics') {
  loadAnalytics();
}

}
function wireNav(){
  $$('.nav-item').forEach(btn=>btn.addEventListener('click',()=>showRoute(btn.dataset.route)));
  $$('[data-route-jump]').forEach(btn=>btn.addEventListener('click',()=>showRoute(btn.dataset.routeJump)));
  window.addEventListener('keydown',(e)=>{
    const tag=(e.target.tagName||'').toLowerCase();
    if(['input','select','textarea'].includes(tag)) return;
    if(e.key>='1' && e.key<='4') showRoute(routes[Number(e.key)-1]);
    if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); $('#quickAddBtn')?.click(); }
  });
}
function wireQuickActions(){
  $('#quickAddBtn')?.addEventListener('click', ()=>{
    showRoute('tasks');
    setTimeout(()=>$('#taskTitle')?.focus(),0);
  });
  document.querySelector('.topbar .btn[title="Notifications"]')?.addEventListener('click',()=>alert('Notifications center coming soon.'));
  document.querySelector('.topbar .btn[title="Help"]')?.addEventListener('click',()=>alert('Shortcuts:\n1..4 tabs\nCtrl/Cmd+K Quick Add'));
}

/*==================== TIMER ENGINE ====================*/
const TIMER = {
  phase: 'idle',          // 'idle' | 'focus' | 'break-short' | 'break-long' | 'paused'
  tickId: null,
  remainingMs: 0,
  totalMs: 0,
  startedAt: null,        // timestamp ms
  completedFocusCount: 0  // finished focus sessions since app start (for long breaks)
};

function mmss(ms){
  const total = Math.max(0, Math.round(ms/1000));
  const m = Math.floor(total/60);
  const s = total % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function setFaceFromMs(ms){ $('#timerFace') && ($('#timerFace').textContent = mmss(ms)); }

function updateTimerButtons(){
  const start=$('#btnStart'), pause=$('#btnPause'), stop=$('#btnStop'), skip=$('#btnSkip');
  const chip=$('#sessionState'); if (!chip) return;
  let uiState='idle';
  if (TIMER.phase==='focus') uiState='focus';
  else if (TIMER.phase==='break-short' || TIMER.phase==='break-long') uiState='break';
  else if (TIMER.phase==='paused') uiState='paused';

  chip.textContent = uiState==='focus' ? 'Focusing' : uiState==='break' ? 'Break' : uiState==='paused' ? 'Paused' : 'Idle';
  chip.className = `chip ${uiState==='focus'?'focus':uiState==='break'?'break':'idle'}`;

  if (start && pause && stop && skip){
    if (uiState==='idle') { start.disabled=false; pause.disabled=true; stop.disabled=true; skip.disabled=true; }
    else if (uiState==='focus') { start.disabled=true; pause.disabled=false; stop.disabled=false; skip.disabled=true; }
    else if (uiState==='break') { start.disabled=true; pause.disabled=false; stop.disabled=false; skip.disabled=false; }
    else if (uiState==='paused') { start.disabled=false; pause.disabled=true; stop.disabled=false; skip.disabled=TIMER.remainingMs<=0; }
  }
}

function startPhase(name){
  TIMER.phase = name;             // 'focus'|'break-short'|'break-long'
  TIMER.startedAt = Date.now();

  if (name === 'focus') {
    state.emotion.currentSessionSamples = [];
    state.emotion.lastAutoCheckTs = 0;
  }

  const mins = (name==='focus') ? state.timer.focus
            : (name==='break-long' ? state.timer.long : state.timer.short);

  TIMER.totalMs = mins * 60_000;
  TIMER.remainingMs = TIMER.totalMs;
  setFaceFromMs(TIMER.remainingMs);
  updateTimerButtons();

  clearInterval(TIMER.tickId);
  TIMER.tickId = setInterval(tick, 1000);
}
function pauseTimer(){
  if (['focus','break-short','break-long'].includes(TIMER.phase)) {
    clearInterval(TIMER.tickId);
    TIMER.tickId = null;
    TIMER.phase = 'paused';
    updateTimerButtons();
  }
}
function stopTimer(){
  clearInterval(TIMER.tickId); TIMER.tickId=null;
  const wasFocus = (TIMER.phase==='focus' || (TIMER.phase==='paused' && TIMER.totalMs===state.timer.focus*60_000));
  const elapsedSec = Math.round((Date.now() - (TIMER.startedAt||Date.now()))/1000);
  if (wasFocus && elapsedSec > 0) {
    if (confirm(`Count ${Math.floor(elapsedSec/60)} min ${elapsedSec%60}s as focus time?`)) {
      const emotionSummary = buildEmotionSummaryForCurrentSession();
      logSession('focus', TIMER.startedAt, Date.now(), elapsedSec, /*completed*/ false, emotionSummary);

      if (emotionSummary && emotionSummary.checks > 0) {
        const avg = emotionSummary.avgScore.toFixed(2);
        emotionNotify(
          'Session finished',
          `Avg attentiveness ${avg}/10 over ${emotionSummary.checks} checks (${emotionSummary.distractedCount} distracted).`
        );
      }

      state.emotion.currentSessionSamples = [];

    }
  }
  TIMER.phase='idle'; setFaceFromMs(state.timer.focus*60_000); updateTimerButtons();
}
function nextBreakKind(){
  const n = state.timer.every || 4;
  return (TIMER.completedFocusCount > 0 && TIMER.completedFocusCount % n === 0) ? 'break-long' : 'break-short';
}
function buildEmotionSummaryForCurrentSession() {
  const samples = state.emotion.currentSessionSamples || [];
  if (!samples.length) return null;

  const checks = samples.length;
  const avgScore = samples.reduce((sum, s) => sum + (s.score || 0), 0) / checks;
  const distractedCount = samples.filter(s => {
    const cls = (s.classification || '').toLowerCase();
    return cls === 'distracted' || (s.score || 0) < 6;
  }).length;

  return {
    checks,
    avgScore,
    distractedCount
  };
}

function finishFocus(){
  TIMER.completedFocusCount++;

  const emotionSummary = buildEmotionSummaryForCurrentSession();

  logSession(
    'focus',
    TIMER.startedAt,
    Date.now(),
    TIMER.totalMs/1000,
    /*completed*/ true,
    emotionSummary
  );

  // nice little summary notification
  if (emotionSummary && emotionSummary.checks > 0) {
    const avg = emotionSummary.avgScore.toFixed(2);
    emotionNotify(
      'Session finished',
      `Avg attentiveness ${avg}/10 over ${emotionSummary.checks} checks (${emotionSummary.distractedCount} distracted).`
    );
  }

  state.emotion.currentSessionSamples = [];

  startPhase(nextBreakKind());
  if (document.querySelector('#route-analytics')?.classList.contains('is-visible')) {
  loadAnalytics();
}

}


function finishBreak(){
  logSession(TIMER.phase, TIMER.startedAt, Date.now(), TIMER.totalMs/1000, /*completed*/ true);
  TIMER.phase='idle';
  clearInterval(TIMER.tickId); TIMER.tickId=null;
  setFaceFromMs(state.timer.focus*60_000);
  updateTimerButtons();
}
function tick(){
  TIMER.remainingMs -= 1000;
  setFaceFromMs(TIMER.remainingMs);
    // while in a focus session, occasionally run auto emotion checks
  try { maybeAutoEmotionCheck(); } catch {}

  if (TIMER.remainingMs <= 0) {
    clearInterval(TIMER.tickId); TIMER.tickId=null;
    if (TIMER.phase==='focus') finishFocus();
    else finishBreak();
  }
}
function wireTimer(){
  $('#btnStart')?.addEventListener('click', ()=>{
    if (TIMER.phase==='paused') {
      TIMER.phase = (TIMER.totalMs === state.timer.focus*60_000) ? 'focus'
                  : (TIMER.totalMs === state.timer.long*60_000)  ? 'break-long' : 'break-short';
      updateTimerButtons();
      clearInterval(TIMER.tickId);
      TIMER.tickId = setInterval(tick, 1000);
      return;
    }
    startPhase('focus');
  });
  $('#btnPause')?.addEventListener('click', pauseTimer);
  $('#btnStop')?.addEventListener('click', stopTimer);
  $('#btnSkip')?.addEventListener('click', ()=>{ if (TIMER.phase.includes('break')) finishBreak(); });

  // presets
  $$('[data-preset]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const [f,s,l,e]=btn.dataset.preset.split('/').map(Number);
      state.timer = { ...state.timer, focus:f, short:s, long:l, every:e };
      saveTimerPrefs();
      if (TIMER.phase==='idle') setFaceFromMs(f*60_000);
    });
  });

  setFaceFromMs(state.timer.focus*60_000);
  updateTimerButtons();
}

/*-------- Sessions history + stats --------*/
async function logSession(type, startTs, endTs, seconds, completed, emotionSummary){
  try {
    const sessions = await window.electronAPI.timer.addSession({
      type, startTs, endTs, seconds, completed, emotionSummary
    });
    state.sessions = Array.isArray(sessions) ? sessions : [];
  } catch {
    state.sessions.push({
      id: Math.random().toString(36).slice(2),
      type, startTs, endTs, seconds, completed, emotionSummary
    });
  }
  paintHistory(); computeStatsAndPaint();
}

async function loadSessions(){
  try {
    const sessions = await window.electronAPI.timer.listSessions();
    state.sessions = Array.isArray(sessions) ? sessions : [];
  } catch { state.sessions = []; }
  paintHistory(); computeStatsAndPaint();
}
function paintHistory(){
  const ul = $('#sessionLog');
  if (!ul) return;
  const items = state.sessions.slice().sort((a,b)=>b.startTs-a.startTs).slice(0,10);
  if (items.length===0) { ul.innerHTML='<li class="empty">No sessions yet.</li>'; return; }
  ul.innerHTML='';
  for (const s of items) {
    const durText = s.seconds >= 60 ? `${Math.round(s.seconds/60)} min` : `${s.seconds}s`;
    const when = new Date(s.startTs).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const li = document.createElement('li');
    li.innerHTML = `<div class="card" style="padding:8px;">
      <strong>${s.type.replace('break-','break ')}</strong> · ${durText} · ${when}
      ${s.completed ? '' : '<span class="chip" style="margin-left:8px;">partial</span>'}
    </div>`;
    ul.appendChild(li);
  }
}

const MS_DAY = 24 * 60 * 60 * 1000;

function computeStreaksFromSessions(sessions) {
  // focus days = unique midnight timestamps for days with at least one focus session
  const focusDays = Array.from(new Set(
    sessions
      .filter(s => s.type === 'focus')
      .map(s => startOfDay(new Date(s.startTs)).getTime())
  )).sort((a, b) => a - b);

  if (focusDays.length === 0) {
    return { current: 0, best: 0 };
  }

  // --- best streak over all time ---
  let best = 1;
  let cur = 1;
  for (let i = 1; i < focusDays.length; i++) {
    if (focusDays[i] === focusDays[i - 1] + MS_DAY) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 1;
    }
  }

  // --- current streak ending today ---
  const todayStart = startOfDay(new Date()).getTime();
  const daySet = new Set(focusDays);
  let current = 0;
  let d = todayStart;
  while (daySet.has(d)) {
    current++;
    d -= MS_DAY;
  }

  return { current, best };
}



function computeStatsAndPaint() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  // today-only stats
  const todays = state.sessions.filter(s =>
    s.type === 'focus' &&
    s.startTs >= todayStart.getTime() &&
    s.startTs < todayEnd.getTime()
  );
  const sessionsCount = todays.length;
  const minutes = todays.reduce((sum, s) => sum + Math.round(s.seconds / 60), 0);

  // streaks from all sessions
  const { current, best } = computeStreaksFromSessions(state.sessions);

  state.stats.sessions   = sessionsCount;
  state.stats.minutes    = minutes;
  state.stats.streak     = current;
  state.stats.bestStreak = best;

  // paint UI
  $('#statSessions') && ($('#statSessions').textContent = sessionsCount);
  $('#statMinutes')  && ($('#statMinutes').textContent  = minutes);
  $('#statStreak')   && ($('#statStreak').textContent   = current);
  $('#statBestStreak') && ($('#statBestStreak').textContent = best);
}


/*==================== TASKS (IPC-backed) ====================*/
const PRIORITY_RANK = { high:3, med:2, low:1, '':0, undefined:0 };
function applyFilterSort(tasks, filter, sort){
  const filtered = tasks.filter(t=>{
    switch(filter){
      case 'active': return !t.done;
      case 'done': return t.done;
      case 'today': return !!t.due && isTodayDate(parseDateISO(t.due));
      case 'overdue': return !!t.due && startOfDay(parseDateISO(t.due)) < startOfDay(new Date()) && !t.done;
      default: return true;
    }
  });
  const sorted = filtered.slice().sort((a,b)=>{
    if(sort==='priority'){
      const pa=PRIORITY_RANK[a.priority], pb=PRIORITY_RANK[b.priority];
      if(pb!==pa) return pb-pa;
    }
    if(sort==='due'){
      const da=parseDateISO(a.due), db=parseDateISO(b.due);
      if(da && db && da.getTime()!==db.getTime()) return da-db;
      if(da && !db) return -1; if(!da && db) return 1;
    }
    if((a.order||0)!==(b.order||0)) return (a.order||0)-(b.order||0);
    return (a.createdAt||0)-(b.createdAt||0);
  });
  return sorted;
}
function renderTasks(){
  const list=$('#taskList'); if (!list) return;
  const tasks=applyFilterSort(state.tasks, state.taskFilter, state.taskSort);
  if(tasks.length===0){ list.innerHTML='<li class="empty">No tasks yet. Add your first one above.</li>'; return; }
  list.innerHTML='';
  for(const t of tasks){
    const li=document.createElement('li');
    li.className='task'; li.dataset.id=t.id;
    li.innerHTML=`
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" ${t.done?'checked':''} />
        <span style="${t.done?'text-decoration:line-through;opacity:.7':''}">${escapeHtml(t.title)}</span>
        ${t.priority?`<span class="chip" title="Priority">${t.priority}</span>`:''}
        ${t.due?`<span class="chip" title="Due">${t.due}</span>`:''}
        <button class="btn small ghost" style="margin-left:auto" title="Delete">Delete</button>
      </div>`;
    li.querySelector('input[type="checkbox"]').addEventListener('change', async (e)=>{
      await window.electronAPI.tasks.update({ id:t.id, done:e.target.checked });
      await loadTasksFromStore();
    });
    li.querySelector('button[title="Delete"]').addEventListener('click', async ()=>{
      await window.electronAPI.tasks.remove(t.id);
      await loadTasksFromStore();
    });
    list.appendChild(li);
  }
}
async function loadTasksFromStore(){
  const arr = await window.electronAPI.tasks.list();
  state.tasks = Array.isArray(arr) ? arr : [];
  renderTasks();
  renderDueToday();   // keep dashboard panel in sync
}
function wireTasks(){
  $('#taskAdd')?.addEventListener('click', async ()=>{
    const title=$('#taskTitle')?.value.trim(); if(!title) return;
    await window.electronAPI.tasks.add({ title, due:$('#taskDue')?.value, priority:$('#taskPriority')?.value });
    $('#taskTitle').value=''; $('#taskDue').value=''; $('#taskPriority').value='';
    await loadTasksFromStore();
  });
  $$('[data-filter]').forEach(btn=>btn.addEventListener('click',()=>{
    $$('[data-filter]').forEach(x=>x.classList.remove('is-active'));
    btn.classList.add('is-active'); state.taskFilter=btn.dataset.filter; renderTasks();
  }));
  $('#taskSort')?.addEventListener('change',(e)=>{ state.taskSort=e.target.value; renderTasks(); });

  // Quick add on dashboard
  $('#quickTaskAdd')?.addEventListener('click', async ()=>{
    const t=$('#quickTaskTitle')?.value.trim(); const d=$('#quickTaskDue')?.value;
    if(!t) return; await window.electronAPI.tasks.add({ title:t, due:d, priority:'' });
    $('#quickTaskTitle').value=''; $('#quickTaskDue').value='';
    await loadTasksFromStore();
  });

  loadTasksFromStore();
}

/*==================== Dashboard: Tasks Due Today ====================*/
function renderDueToday() {
  const list  = document.getElementById('dueTodayList') || document.getElementById('dueList');
  if (!list) return;

  const today = new Date();
  const dueToday = state.tasks.filter(t => {
    const d = parseDateISO(t.due);
    return !t.done && d && isSameDay(d, today);
  });

  list.innerHTML = '';

  if (dueToday.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No due tasks today. Add one below.';
    list.appendChild(li);
    return;
  }

  const PR = { high:3, med:2, low:1, '':0, undefined:0 };
  dueToday.sort((a,b)=>{
    const pa=PR[a.priority], pb=PR[b.priority];
    if (pb!==pa) return pb-pa;
    return (a.createdAt||0) - (b.createdAt||0);
  });

  for (const t of dueToday) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" ${t.done?'checked':''} />
        <span>${escapeHtml(t.title)}</span>
        ${t.priority ? `<span class="chip">${t.priority}</span>` : ''}
        <button class="btn small ghost" style="margin-left:auto" title="Open in Tasks">Open</button>
      </div>
    `;

    //toggle done from dashboard
    const cbox = li.querySelector('input[type="checkbox"]');
    cbox?.addEventListener('change', async (e)=>{
      await window.electronAPI.tasks.update({ id: t.id, done: e.target.checked });
      await loadTasksFromStore();
    });

    //jump to tasks tab
    const openBtn = li.querySelector('button[title="Open in Tasks"]') || li.querySelector('button[title="Open"]');
    openBtn?.addEventListener('click', ()=>{
      showRoute('tasks');
      setTimeout(()=>document.querySelector('[data-filter="today"]')?.click(), 0);
    });

    list.appendChild(li);
  }
}

function wireDueTodayPanel() {
  document.getElementById('dueViewAll')?.addEventListener('click', ()=>{
    setTimeout(()=>document.querySelector('[data-filter="today"]')?.click(), 0);
  });
}

/*==================== Plan & Settings ====================*/
function wirePlan(){
  const list=$('#planList'); if (!list) return;
  const empty=()=>{ list.innerHTML='<li class="empty">No upcoming sessions.</li>'; };
  $('#planAdd')?.addEventListener('click',()=>{
    const date=$('#planDate')?.value, time=$('#planTime')?.value, dur=$('#planDuration')?.value, note=$('#planNote')?.value.trim();
    if(!date||!time||!dur) return;
    if(list.querySelector('.empty')) list.innerHTML='';
    const li=document.createElement('li');
    li.innerHTML=`<div class="card" style="padding:12px;"><strong>${date} ${time}</strong> — ${dur} min ${note?('· '+note):''}</div>`;
    list.appendChild(li);
    if ($('#planNote')) $('#planNote').value='';
  });
  $('#planAddGCal')?.addEventListener('click', async ()=>{
    const date = $('#planDate')?.value;
    const time = $('#planTime')?.value;
    const dur  = $('#planDuration')?.value;
    const note = $('#planNote')?.value.trim();

    await createGcalEvent(date, time, dur, 'Study session', note);
  });

  empty();
}
function wireSettings(){
  // Theme
  const themeSel = $('#setTheme');
  themeSel?.addEventListener('change', e => { const m = e.target.value; applyTheme(m); saveTheme(m); });

  // Accent
  $('#setAccent')?.addEventListener('input', e => {
    document.documentElement.style.setProperty('--primary', e.target.value);
  });

  // Timer inputs
  const focus = $('#setFocus');
  const short = $('#setShort');
  const long  = $('#setLong');
  const every = $('#setEvery');

  if (focus && short && long && every) {
    focus.value = state.timer.focus;
    short.value = state.timer.short;
    long.value  = state.timer.long;
    every.value = state.timer.every;

    const applyAndSave = () => {
      state.timer.focus = Math.max(1, Number(focus.value) || 25);
      state.timer.short = Math.max(1, Number(short.value) || 5);
      state.timer.long  = Math.max(1, Number(long.value)  || 15);
      state.timer.every = Math.max(1, Number(every.value) || 4);
      saveTimerPrefs();
      if (TIMER.phase === 'idle') setFaceFromMs(state.timer.focus * 60_000);
    };

    [focus, short, long, every].forEach(el => el.addEventListener('input', applyAndSave));
  }
}

/*==================== Timer quick adjust ====================*/
function wireTimerAdjust(){
  const canEdit = () => TIMER.phase === 'idle';

  const applyMinutes = (mins, save = true) => {
    mins = clamp(Math.round(mins), 1, 180);
    state.timer.focus = mins;
    if (save) saveTimerPrefs();
    if (canEdit()) setFaceFromMs(mins * 60_000);
  };

  const bump = (delta) => {
    if (!canEdit()) { alert('Pause/stop the session to change minutes.'); return; }
    applyMinutes(state.timer.focus + delta);
  };
  $('#dec1')?.addEventListener('click', ()=> bump(-1));
  $('#inc1')?.addEventListener('click', ()=> bump(+1));
  $('#dec5')?.addEventListener('click', ()=> bump(-5));
  $('#inc5')?.addEventListener('click', ()=> bump(+5));

  $('#saveDefault')?.addEventListener('click', ()=> {
    saveTimerPrefs();
    $('#saveDefault').textContent = 'Saved ✓';
    setTimeout(()=>$('#saveDefault').textContent = 'Save default', 900);
  });

  const face = $('#timerFace');
  const edit = $('#editMinutes');

  face?.addEventListener('dblclick', ()=>{
    if (!canEdit()) { alert('Pause/stop the session to change minutes.'); return; }
    if (!edit) return;
    edit.value = String(state.timer.focus);
    edit.classList.add('is-visible');
    edit.focus();
    edit.select();
  });
  const commit = () => {
    const v = Number(edit.value);
    if (!Number.isFinite(v)) { edit.classList.remove('is-visible'); return; }
    applyMinutes(v);
    edit.classList.remove('is-visible');
  };
  edit?.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') edit.classList.remove('is-visible');
  });
  edit?.addEventListener('blur', commit);
}

/*==================== AI Chatbot (backend via IPC) ====================*/
/*==================== AI Chatbot (backend via IPC) ====================*/
function wireAI(){
  const topicInput     = $('#aiTopic');
  const difficultySel  = $('#aiDifficulty');
  const numQInput      = $('#aiNumQuestions');
  const quizBtn        = $('#aiQuizBtn');

  const questionInput  = $('#aiQuestionInput');
  const askBtn         = $('#aiAskBtn');

  const summaryModeSel = $('#aiSummaryMode');
  const summarizeBtn   = $('#aiSummarizeBtn');

  const addPdfBtn = $('#aiAddPdfBtn');

  const resultBox      = $('#aiResult');
  const statusLabel    = $('#aiStatus');

  // if the route doesn't exist (older HTML), bail
  if (!resultBox) return;

  const setStatus = (msg) => {
    if (statusLabel) statusLabel.textContent = msg || '';
  };

  const showError = (msg) => {
    setStatus('');
    resultBox.textContent = '⚠ ' + msg;
  };

  // ---- quiz helpers ----
  function resetQuiz() {
    state.ai.quiz = {
      questions: [],
      currentIndex: 0,
      answers: [],
      inProgress: false,
      finished: false,
      report: null
    };
  }

  function renderQuiz() {
    const quiz = state.ai.quiz;
    const box = resultBox;

    // no quiz yet
    if (!quiz.questions.length) {
      box.innerHTML = `
        <div style="color:var(--muted);">
          No quiz in progress. Generate a quiz from the left panel to start.
        </div>
      `;
      return;
    }

    // finished → show report
    if (quiz.finished && quiz.report) {
      const { correctCount, total, percent, details } = quiz.report;

      const summaryHtml = `
        <div style="margin-bottom:12px;">
          <strong>Score:</strong> ${correctCount}/${total} (${percent}%)  
        </div>
      `;

      const itemsHtml = details.map((item, idx) => {
        const q = item.question;
        const your = item.yourAnswer
          ? item.yourAnswer.toUpperCase()
          : '<em>Not answered</em>';
        const correct = item.correctAnswer.toUpperCase();
        const isCorrect = item.isCorrect;
        const yourText = item.yourAnswerText || '';
        const correctText = item.correctAnswerText || '';

        return `
          <div class="card" style="padding:8px 10px; margin-bottom:8px;">
            <div style="margin-bottom:4px;"><strong>Q${idx+1}.</strong> ${escapeHtml(q)}</div>
            <div style="font-size:13px;">
              <div><strong>Your answer:</strong> ${your}${yourText ? ` — ${escapeHtml(yourText)}` : ''}</div>
              <div><strong>Correct answer:</strong> ${correct}${correctText ? ` — ${escapeHtml(correctText)}` : ''}</div>
              <div style="margin-top:2px;">
                ${isCorrect ? '✅ Correct' : '❌ Incorrect'}
              </div>
            </div>
          </div>
        `;
      }).join('');

      box.innerHTML = summaryHtml + itemsHtml + `
        <button class="btn small ghost" id="aiNewQuizBtn" style="margin-top:8px;">
          Start a new quiz
        </button>
      `;

      $('#aiNewQuizBtn')?.addEventListener('click', () => {
        resetQuiz();
        setStatus('Generate a quiz on the left to start.');
        renderQuiz();
      });

      return;
    }

    // otherwise: show current question
    const idx = quiz.currentIndex;
    const total = quiz.questions.length;
    const q = quiz.questions[idx];
    const selected = quiz.answers[idx] || '';

    const optionRow = (key, label) => `
      <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;">
        <input type="radio" name="aiOption" value="${key}" ${selected === key ? 'checked' : ''}/>
        <span>${key.toUpperCase()}) ${escapeHtml(label || '')}</span>
      </label>
    `;

    box.innerHTML = `
      <div style="margin-bottom:8px;font-size:13px;color:var(--muted);">
        Question ${idx+1} of ${total}
      </div>
      <div style="margin-bottom:8px;">
        ${escapeHtml(q.question || '')}
      </div>
      <form id="aiQuizForm" style="display:flex;flex-direction:column;gap:4px;font-size:14px;">
        ${optionRow('a', q.a)}
        ${optionRow('b', q.b)}
        ${optionRow('c', q.c)}
        ${optionRow('d', q.d)}
      </form>
      <div style="display:flex;justify-content:space-between;margin-top:10px;gap:8px;">
        <button class="btn small ghost" id="aiPrevBtn" ${idx===0 ? 'disabled' : ''}>Previous</button>
        <div style="margin-left:auto;display:flex;gap:8px;">
          ${idx < total-1
            ? '<button class="btn small" id="aiNextBtn">Next</button>'
            : '<button class="btn small" id="aiSubmitBtn">Submit quiz</button>'
          }
        </div>
      </div>
    `;

    const form = $('#aiQuizForm');

    const getSelected = () => {
      const input = form.querySelector('input[name="aiOption"]:checked');
      return input ? input.value : '';
    };

    $('#aiPrevBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      quiz.answers[idx] = getSelected() || quiz.answers[idx];
      if (quiz.currentIndex > 0) quiz.currentIndex--;
      renderQuiz();
    });

    $('#aiNextBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      const sel = getSelected();
      if (!sel) {
        alert('Choose an option before moving to the next question.');
        return;
      }
      quiz.answers[idx] = sel;
      if (quiz.currentIndex < total-1) quiz.currentIndex++;
      renderQuiz();
    });

    $('#aiSubmitBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      const sel = getSelected();
      if (sel) quiz.answers[idx] = sel;

      const unanswered = quiz.answers.filter(a => !a).length;
      if (unanswered > 0) {
        const ok = confirm(`You have ${unanswered} unanswered question(s). Submit anyway?`);
        if (!ok) return;
      }

      // build report
      let correctCount = 0;
      const details = quiz.questions.map((q, i) => {
        const your = quiz.answers[i] || '';
        const correct = (q.correct || '').toLowerCase();
        const isCorrect = your && your.toLowerCase() === correct;
        if (isCorrect) correctCount++;

        const answerText = (opt) => {
          switch(opt) {
            case 'a': return q.a || '';
            case 'b': return q.b || '';
            case 'c': return q.c || '';
            case 'd': return q.d || '';
            default: return '';
          }
        };

        return {
          question: q.question || '',
          yourAnswer: your,
          correctAnswer: q.correct || '',
          yourAnswerText: answerText(your.toLowerCase()),
          correctAnswerText: answerText(correct),
          isCorrect
        };
      });

      const totalQ = quiz.questions.length;
      const percent = totalQ > 0 ? Math.round(correctCount * 100 / totalQ) : 0;

      quiz.inProgress = false;
      quiz.finished = true;
      quiz.report = { correctCount, total: totalQ, percent, details };

      setStatus(`Quiz finished: ${correctCount}/${totalQ} correct (${percent}%).`);
      renderQuiz();
    });
  }

  // plain text result for summary / doubt
  const showPlainResult = (text) => {
    resetQuiz();
    resultBox.textContent = text || '';
  };

  // ----- load stored PDFs and render -----  
  loadAIPdfs();
  renderAIPdfList();

    addPdfBtn?.addEventListener('click', async () => {
    setStatus('Select a PDF to add to your notes…');
    try {
      const res = await window.electronAPI.ai.ingest();
      console.log('ai:ingest result', res);

      if (!res || !res.ok) {
        if (res && res.error === 'cancelled') {
          setStatus('Upload cancelled.');
          return;
        }
        showError(res?.error || 'Failed to add PDF.');
        return;
      }

      const pages = res.data.pages ?? 0;
      const path  = res.data.path ?? 'file';
      const name  = path.split(/[\\/]/).pop() || path;

      // store in state + localStorage
      const entry = { path, name, pages };
      state.ai.pdfs.push(entry);
      state.ai.selectedPdf = entry; // auto-select latest
      saveAIPdfs();
      renderAIPdfList();

      setStatus(`Added "${name}" (${pages} pages) to your notes.`);
    } catch (err) {
      console.error('ai:ingest error', err);
      showError(String(err));
    }
  });


  // ---- QUIZ BUTTON ----
  quizBtn?.addEventListener('click', async () => {
    const topic = topicInput?.value.trim() || '';
    const difficulty = difficultySel?.value || 'Medium';
    const n = Number(numQInput?.value || 5) || 5;

    if (!topic) {
      alert('Type a topic first.');
      return;
    }

    setStatus('Generating quiz…');
    resetQuiz();
    resultBox.textContent = '';

    try {
      const res = await window.electronAPI.ai.quiz(topic, difficulty, n);
      console.log('ai:quiz result', res);
      if (!res || !res.ok || res.data?.ok === false) {
        showError(res?.error || res?.data?.error || 'Quiz failed.');
        return;
      }

      const qs = res.data.questions || [];
      if (!qs.length) {
        showError('No questions generated. Try another topic or difficulty.');
        return;
      }

      state.ai.quiz.questions = qs;
      state.ai.quiz.currentIndex = 0;
      state.ai.quiz.answers = new Array(qs.length).fill('');
      state.ai.quiz.inProgress = true;
      state.ai.quiz.finished = false;
      state.ai.quiz.report = null;

      setStatus(`Quiz ready: ${qs.length} questions on "${topic}".`);
      renderQuiz();
    } catch (err) {
      console.error('ai:quiz error', err);
      showError(String(err));
    }
  });

  // ---- DOUBT BUTTON ----
  askBtn?.addEventListener('click', async () => {
    const question = questionInput?.value.trim() || '';
    if (!question) {
      alert('Type your doubt first.');
      return;
    }

    setStatus('Thinking…');
    resultBox.textContent = '';

    try {
      const res = await window.electronAPI.ai.doubt(
        question,
        state.ai.lastAnswer || ''
      );
      console.log('ai:doubt result', res);
      if (!res || !res.ok || res.data?.ok === false) {
        showError(res?.error || res?.data?.error || 'Doubt solver failed.');
        return;
      }

      const ans = res.data.answer || '';
      showPlainResult(ans);
      state.ai.lastAnswer = ans;
      setStatus('Answer ready. You can ask a follow-up like "explain better".');
    } catch (err) {
      console.error('ai:doubt error', err);
      showError(String(err));
    }
  });

  // ---- SUMMARY BUTTON ----
    summarizeBtn?.addEventListener('click', async () => {
    const mode = summaryModeSel?.value || 'Detailed';

    // figure out which PDF to summarize
    const selected = state.ai.selectedPdf;
    let sourcePath = selected ? selected.name: null;

    if (!sourcePath) {
      const ok = confirm('No specific note selected. Summarize ALL notes instead?');
      if (!ok) {
        setStatus('');
        return;
      }
    }

    setStatus('Summarizing your notes (this can take a bit)…');
    resultBox.textContent = '';

    try {
      // IMPORTANT: preload/main must be updated to accept (mode, sourcePath)
      const res = await window.electronAPI.ai.summarize(mode, sourcePath);
      console.log('ai:summarize result', res);
      if (!res || !res.ok ) {
        showError(res?.error || res?.data?.error || 'Summary failed.');
        return;
      }

      showPlainResult(res.summary || '');
      setStatus(`Summary ready (${mode}).`);
    } catch (err) {
      console.error('ai:summarize error', err);
      showError(String(err));
    }
  });




}



/*==================== Emotion / Attentiveness ====================*/
function wireEmotion() {
  const consentCheckbox = $('#chkEmotionConsent');
  const video = $('#emotionVideo');
  const runBtn = $('#emotionRun');
  const statusEl = $('#emotionStatus');
  const lastResultEl = $('#emotionLastResult');

  if (!video || !runBtn || !consentCheckbox) return; // route not present

  let previewStream = null;

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg || '';
  };

  const setLastResult = (msg) => {
    if (lastResultEl) lastResultEl.textContent = msg || '';
  };

  async function startPreview() {
    // only if consent and not already running
    if (!state.emotion.allow) return;
    if (previewStream) return;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus('Camera not supported in this environment.');
        return;
      }
      setStatus('Requesting camera access…');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      previewStream = stream;
      video.srcObject = stream;
      await video.play();
      setStatus('Preview running. Checks will pause the camera briefly.');
    } catch (err) {
      console.error('preview error', err);
      setStatus('Could not start camera preview. Check permissions in your OS.');
    }
  }

  function stopPreview() {
    if (previewStream) {
      previewStream.getTracks().forEach(t => t.stop());
      previewStream = null;
    }
    video.srcObject = null;
  }

  // consent checkbox wiring
  consentCheckbox.addEventListener('change', async () => {
    state.emotion.allow = consentCheckbox.checked;
    saveEmotionPrefs();

    if (state.emotion.allow) {
      // ask for Notification permission once when user opts in
      if ('Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch {}
      }
      startPreview();
    } else {
      stopPreview();
      setStatus('');
    }
  });

  // initial state from prefs
  consentCheckbox.checked = !!state.emotion.allow;
  if (state.emotion.allow) {
    startPreview();
  }

  // ---- manual check ("Run check now") ----
  async function runEmotionCheckManual() {
    if (!state.emotion.allow) {
      alert('Please enable webcam consent above first.');
      return;
    }
    if (state.emotion.isRunning) return;

    state.emotion.isRunning = true;
    runBtn.disabled = true;
    setStatus('Running attentiveness check… webcam preview will pause briefly.');
    setLastResult('Running attentiveness check…');

    // free webcam for Python (must do this – OS limitation)
    stopPreview();

    try {
      const res = await window.electronAPI.ai.attentive();
      console.log('ai:attentive (manual) result', res);

      if (!res || !res.ok || res.data?.ok === false) {
        const msg = res?.error || res?.data?.error || 'Attentiveness check failed.';
        setStatus('');
        setLastResult('⚠ ' + msg);
        return;
      }

      const payload = res.data || {};
      const score = typeof payload.score === 'number'
        ? payload.score
        : (payload.normalized_score ?? 0);
      const classification = payload.classification || 'Unknown';
      const emotion = (payload.details && payload.details.emotion) || payload.emotion || '';

      // 1) Save into history
      state.emotion.history.unshift({
        ts: Date.now(),
        score,
        classification,
        emotion,
        source: 'manual'
      });
      state.emotion.history = state.emotion.history.slice(0, 50);
      saveEmotionHistory();
      renderEmotionHistory();

      // 2) If a focus session is running, append to current-session samples
      if (TIMER.phase === 'focus') {
        state.emotion.currentSessionSamples.push({ ts: Date.now(), score, classification, emotion });
      }

      // 3) Notify user (but DO NOT show numbers in the panel)
      const isDistracted = (classification || '').toLowerCase() === 'distracted' || score < 6;
      if (isDistracted) {
        emotionNotify('StudyBuddy', 'You seem a bit distracted. Try to refocus for a few minutes.');
      } else {
        emotionNotify('StudyBuddy', 'Nice, you’re staying focused. Keep going!');
      }

      setStatus('Check finished.');
      setLastResult('Last check finished. Details saved to history.');
    } catch (err) {
      console.error('ai:attentive (manual) error', err);
      setStatus('');
      setLastResult('⚠ ' + String(err));
    } finally {
      state.emotion.isRunning = false;
      runBtn.disabled = false;

      // restart preview if consent still on and user is on this tab
      if (state.emotion.allow) {
        startPreview();
      }
    }
  }

  runBtn.addEventListener('click', runEmotionCheckManual);

  // initial history render
  renderEmotionHistory();
}




/*==================== Boot ====================*/
function boot(){
  applyTheme(loadTheme());
  loadTimerPrefs();

  setDate(); wireNav(); wireThemeToggle(); wireQuickActions();

  wireTimer(); wireTimerAdjust();
  wireTasks(); wirePlan(); wireSettings();

  wireDueTodayPanel();
  loadIntegrations();
  renderGcalUI();
  wireGcalUI();

  loadSessions(); // pull existing history and paint stats

  loadAIPdfs();
  renderAIPdfList();
  wireAI();

  loadEmotionPrefs();
  loadEmotionHistory();
  renderEmotionHistory();
  wireEmotion();
}
document.addEventListener('DOMContentLoaded', boot);

let chartInstances = {};

function destroyCharts() {
  Object.values(chartInstances).forEach(chart => {
    if (chart) chart.destroy();
  });
  chartInstances = {};
}

async function loadAnalytics() {


  const container = document.getElementById('analyticsStats');
  if (!container) return;

  destroyCharts();

  const focusSessions = state.sessions.filter(s => s.type === 'focus');
  const breakSessions = state.sessions.filter(s => s.type.includes('break'));

  const totalMinutes = focusSessions.reduce((sum, s) => sum + s.seconds/60, 0);

  const completionRate = focusSessions.length
    ? ((focusSessions.filter(s => s.completed).length / focusSessions.length) * 100).toFixed(1)
    : 0;

  const avgAttention = state.emotion.history.length
    ? (state.emotion.history.reduce((sum,e)=>sum+e.score,0)
        / state.emotion.history.length).toFixed(2)
    : 0;

  container.innerHTML = `
    <div class="card" style="padding:16px;">
      <h4>Total Focus</h4>
      <div style="font-size:22px;font-weight:600;">${totalMinutes.toFixed(1)} min</div>
    </div>

    <div class="card" style="padding:16px;">
      <h4>Completion Rate</h4>
      <div style="font-size:22px;font-weight:600;">${completionRate}%</div>
    </div>

    <div class="card" style="padding:16px;">
      <h4>Avg Attention</h4>
      <div style="font-size:22px;font-weight:600;">${avgAttention}/10</div>
    </div>

    <div class="card" style="padding:16px;">
      <h4>Total Sessions</h4>
      <div style="font-size:22px;font-weight:600;">${focusSessions.length}</div>
    </div>
  `;

  // 🔹 Focus Trend (line)
  chartInstances.focus = new Chart(document.getElementById('focusChart'), {
    type: 'line',
    data: {
      labels: focusSessions.map((_,i)=>`S${i+1}`),
      datasets: [{
        label: 'Focus Minutes',
        data: focusSessions.map(s => (s.seconds/60).toFixed(1)),
        tension: 0.3
      }]
    }
  });
  // 🔹 Focus vs Distracted (from emotion history)
const distracted = state.emotion.history.filter(e =>
  (e.classification || '').toLowerCase() === 'distracted'
).length;

const focused = state.emotion.history.length - distracted;

chartInstances.distracted = new Chart(
  document.getElementById('distractedPie'),
  {
    type: 'doughnut',
    data: {
      labels: ['Focused', 'Distracted'],
      datasets: [{
        data: [focused, distracted],
        backgroundColor: [
          'rgba(139,124,251,0.85)',   // soft purple (matches your accent)
          'rgba(255,99,132,0.75)'     // softer red
        ],
        borderColor: [
          'rgba(139,124,251,1)',
          'rgba(255,99,132,1)'
        ],
        borderWidth: 1
      }]
    },
    options: {
      plugins: {
        legend: {
          labels: {
            color: '#cbd5e1',   // soft text color
            font: { size: 12 }
          }
        }
      }
    }
  }
);



  // 🔹 Attention Trend
   // 🔹 Attention Trend (FIXED ORDER)

const att = state.emotion.history
  .slice(0,10)                
  .sort((a, b) => a.ts - b.ts);  

chartInstances.attention = new Chart(
  document.getElementById('attentionChart'),
  {
    type: 'line',
    data: {
      labels: att.map(e => {
      const d = new Date(e.ts);
      const h = d.getHours().toString().padStart(2, '0');
      const m = d.getMinutes().toString().padStart(2, '0');
      return `${h}:${m}`;
    }),

      datasets: [{
        label: 'Attention Score',
        data: att.map(e => e.score),
        tension: 0.3
      }]
    },
    options: {
      scales: {
        y: { min: 0, max: 10 }
      }
    }
  }
);


  // 🔹 Session Duration Distribution
  chartInstances.duration = new Chart(document.getElementById('sessionDurationChart'), {
    type: 'bar',
    data: {
      labels: focusSessions.map((_,i)=>`S${i+1}`),
      datasets: [{
        label: 'Duration (min)',
        data: focusSessions.map(s => (s.seconds/60).toFixed(1))
      }]
    }
  });

  // 🔹 Focus vs Break Ratio
  chartInstances.ratio = new Chart(
  document.getElementById('focusBreakChart'),
  {
    type: 'doughnut',
    data: {
      labels: ['Focus Sessions', 'Break Sessions'],
      datasets: [{
        data: [focusSessions.length, breakSessions.length],
        backgroundColor: [
          'rgba(139,124,251,0.85)',   // soft purple (focus)
          'rgba(255,159,64,0.75)'     // soft orange (break)
        ],
        borderColor: [
          'rgba(139,124,251,1)',
          'rgba(255,159,64,1)'
        ],
        borderWidth: 1
      }]
    },
    options: {
      cutout: '65%',   // makes it thinner and cleaner
      plugins: {
        legend: {
          labels: {
            color: '#cbd5e1',
            font: { size: 12 }
          }
        }
      }
    }
  }
);


  renderStreakGrid();

  document.getElementById('printAnalyticsBtn').onclick = () => window.print();
}




function renderStreakGrid() {
  const grid = document.getElementById('streakGrid');
  if (!grid) return;

  grid.innerHTML = '';
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(7, 1fr)';
  grid.style.gap = '4px';

  const days = 30; // last 12 weeks
  const today = new Date();

  for (let i = days; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);

    const start = new Date(d);
    start.setHours(0,0,0,0);

    const end = new Date(start);
    end.setDate(end.getDate()+1);

    const minutes = state.sessions
      .filter(s =>
        s.type === 'focus' &&
        s.startTs >= start.getTime() &&
        s.startTs < end.getTime()
      )
      .reduce((sum, s) => sum + s.seconds/60, 0);

    const cell = document.createElement('div');
    cell.style.height = '14px';
    cell.style.borderRadius = '3px';

    let intensity = Math.min(minutes / 60, 1); // cap at 60 min
    cell.style.background =
      minutes === 0
        ? '#2a2a2a'
        : `rgba(139,124,251,${0.2 + intensity})`;

    cell.title = `${d.toDateString()} — ${Math.round(minutes)} min`;

    grid.appendChild(cell);
  }
}

