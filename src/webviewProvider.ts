import * as vscode from 'vscode';
import { Poller, StatusState } from './poller';

export class AiRunnerProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiRunner.panel';
    private _view?: vscode.WebviewView;
    private _poller?: Poller;
    private _modelFamily: string = 'gpt-4.1';

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.command === 'start') { this._startPoller(); }
            else if (msg.command === 'stop') { this._stopPoller(); }
            else if (msg.command === 'setModel') {
                this._modelFamily = msg.family;
                if (this._poller) { this._poller.modelFamily = msg.family; }
            }
        });

    }

    private _getConfig() {
        const cfg = vscode.workspace.getConfiguration('aiRunner');
        return {
            serverUrl: cfg.get<string>('serverUrl', 'https://ordenes.finearom.co/ai'),
            apiKey:    cfg.get<string>('apiKey', 'finearom-ai-2025')
        };
    }

    private _startPoller() {
        if (this._poller?.running) { return; }
        this._poller?.dispose();

        const { serverUrl, apiKey } = this._getConfig();

        this._poller = new Poller(serverUrl, apiKey, {
            onStatus: (state: StatusState, isRunning: boolean) => {
                this._post({ command: 'status', state, serverUrl, isRunning });
            },
            onLog: (type, text, extra) => {
                this._post({
                    command: 'log',
                    type,
                    text,
                    timestamp: new Date().toLocaleTimeString('es-MX', { hour12: false }),
                    conversationId: extra?.conversationId,
                    newChat: extra?.newChat
                });
            }
        });
        this._poller.modelFamily = this._modelFamily;

        this._poller.start();
    }

    private _stopPoller() {
        this._poller?.stop();
    }

    public startPoller()  { this._startPoller(); }
    public stopPoller()   { this._stopPoller();  }
    public disposePoller() { this._poller?.dispose(); }

    private _post(msg: unknown) {
        this._view?.webview.postMessage(msg);
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex; flex-direction: column; height: 100vh;
  }

  /* ── HEADER ── */
  .header { flex-shrink: 0; padding: 10px 12px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .header-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; opacity: .8; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 10px;
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
  }
  .badge .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .badge.idle       { background: rgba(128,128,128,.2); color: var(--vscode-descriptionForeground); }
  .badge.idle .dot  { background: var(--vscode-descriptionForeground); }
  .badge.processing { background: rgba(0,122,204,.2); color: #4fc3f7; }
  .badge.processing .dot { background: #4fc3f7; animation: pulse 1.2s ease-in-out infinite; }
  .badge.success    { background: rgba(35,134,54,.2); color: #4caf50; }
  .badge.success .dot { background: #4caf50; }
  .badge.error      { background: rgba(229,83,75,.15); color: #f48771; }
  .badge.error .dot { background: #f48771; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.7)} }
  .server-row { display: flex; align-items: center; gap: 5px; margin-bottom: 5px; }
  .server-label { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .server-url {
    font-size: 10px; font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-textLink-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .model-row { display: flex; align-items: center; gap: 5px; }
  .model-label { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .model-select {
    flex: 1; font-size: 10px; font-family: inherit;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; padding: 2px 4px; cursor: pointer; outline: none;
  }
  .model-select:focus { border-color: var(--vscode-focusBorder); }
  .server-url.empty { color: var(--vscode-descriptionForeground); font-style: italic; font-family: inherit; }

  /* ── TABS ── */
  .tabs {
    flex-shrink: 0; display: flex;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-input-background);
  }
  .tab {
    flex: 1; padding: 6px 8px; border: none; background: none; cursor: pointer;
    font-family: inherit; font-size: 11px; font-weight: 600;
    color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .06em;
    border-bottom: 2px solid transparent; transition: color .15s, border-color .15s;
    display: flex; align-items: center; justify-content: center; gap: 5px;
  }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, #007acc); }
  .tab:hover:not(.active) { color: var(--vscode-foreground); }
  .hist-count {
    background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff);
    border-radius: 8px; padding: 0 5px; font-size: 9px; min-width: 16px;
    text-align: center; line-height: 14px; display: inline-block;
  }
  .hist-count.zero { opacity: .35; }

  /* ── SCROLL VIEWS ── */
  .view { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
  .view::-webkit-scrollbar { width: 5px; }
  .view::-webkit-scrollbar-thumb { background: rgba(128,128,128,.3); border-radius: 3px; }

  /* ── EMPTY STATE ── */
  .empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; gap: 8px; color: var(--vscode-descriptionForeground);
    opacity: .4; user-select: none; min-height: 80px;
  }
  .empty-icon { font-size: 24px; }
  .empty-text { font-size: 11px; }

  /* ── EXCHANGE (prompt + response pair) ── */
  .exchange { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .bubble { border-radius: 4px; padding: 6px 8px; border-left: 2px solid transparent; }
  .bubble.sm { padding: 4px 7px; }
  .bubble-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 3px; opacity: .7; }
  .bubble-text { font-size: 11.5px; line-height: 1.45; word-break: break-word; }
  .bubble.sm .bubble-text { font-size: 11px; }

  .bubble.prompt   { background: rgba(0,122,204,.08); border-left-color: var(--vscode-textLink-foreground); }
  .bubble.prompt   .bubble-label { color: var(--vscode-textLink-foreground); }
  .bubble.prompt   .bubble-text  { opacity: .9; }
  .bubble.response { background: rgba(76,175,80,.07); border-left-color: #4caf50; }
  .bubble.response .bubble-label { color: #4caf50; }
  .bubble.response .bubble-text  { opacity: .85; }

  /* Pending animation */
  .pending-dots { display: inline-flex; gap: 3px; align-items: center; margin-top: 4px; }
  .pending-dots span {
    width: 5px; height: 5px; border-radius: 50%; background: #4fc3f7;
    animation: bounce 1.2s ease-in-out infinite;
  }
  .pending-dots span:nth-child(2) { animation-delay: .2s; }
  .pending-dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes bounce { 0%,80%,100%{transform:scale(.6)} 40%{transform:scale(1)} }

  /* ── HISTORY ITEMS ── */
  .hist-item { border-radius: 4px; border: 1px solid var(--vscode-panel-border); overflow: hidden; margin-bottom: 4px; }
  .hist-item-header {
    display: flex; align-items: center; gap: 6px; padding: 6px 8px;
    cursor: pointer; background: var(--vscode-input-background); user-select: none;
  }
  .hist-item-header:hover { background: var(--vscode-list-hoverBackground); }
  .hist-arrow { font-size: 9px; opacity: .6; flex-shrink: 0; transition: transform .15s; }
  .hist-item.open .hist-arrow { transform: rotate(90deg); }
  .hist-item-meta { flex: 1; min-width: 0; }
  .hist-item-time { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: .7; }
  .hist-item-preview { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .9; }
  .hist-item-count { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; opacity: .6; }
  .hist-item-body {
    display: none; padding: 6px 8px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-direction: column; gap: 3px;
  }
  .hist-item.open .hist-item-body { display: flex; }

  /* ── FOOTER ── */
  .footer {
    flex-shrink: 0; padding: 8px 12px; border-top: 1px solid var(--vscode-panel-border);
    display: flex; align-items: center; gap: 8px;
  }
  .running-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    background: var(--vscode-descriptionForeground); opacity: .3; transition: background .2s, opacity .2s;
  }
  .running-dot.on { background: #4caf50; opacity: 1; animation: glow 2s ease-in-out infinite; }
  @keyframes glow { 0%,100%{box-shadow:0 0 0 0 rgba(76,175,80,.4)} 50%{box-shadow:0 0 0 4px rgba(76,175,80,0)} }
  .toggle-btn {
    flex: 1; padding: 6px 12px; background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border: none; border-radius: 3px;
    font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .2s;
  }
  .toggle-btn:hover { background: var(--vscode-button-hoverBackground); }
  .toggle-btn:disabled { opacity: .5; cursor: not-allowed; }
  .toggle-btn.stop { background: var(--vscode-statusBarItem-errorBackground, #c72e0f); color: #fff; }
  .toggle-btn.stop:hover { background: #d9362a; }
</style>
</head>
<body>

<div class="header">
  <div class="header-top">
    <span class="title">AI Runner</span>
    <div class="badge idle" id="badge"><span class="dot"></span><span id="badgeLabel">Idle</span></div>
  </div>
  <div class="server-row">
    <span class="server-label">Server:</span>
    <span class="server-url empty" id="serverUrl">–</span>
  </div>
  <div class="model-row">
    <span class="model-label">Model:</span>
    <select class="model-select" id="modelSelect" onchange="onModelChange(this.value)">
      <option value="gpt-4.1" selected>GPT-4.1 (gratis)</option>
      <option value="gpt-4o">GPT-4o</option>
      <option value="gpt-4">GPT-4</option>
      <option value="o4-mini">o4-mini</option>
      <option value="o3-mini">o3-mini</option>
      <option value="claude-3.5-sonnet">Claude 3.5 Sonnet</option>
      <option value="claude-3.7-sonnet">Claude 3.7 Sonnet</option>
      <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
    </select>
  </div>
</div>

<div class="tabs">
  <button class="tab active" id="tabCurrent" onclick="switchTab('current')">Actual</button>
  <button class="tab" id="tabHistory" onclick="switchTab('history')">
    Historial <span class="hist-count zero" id="histCount">0</span>
  </button>
</div>

<div class="view" id="viewCurrent">
  <div class="empty" id="emptyCurrent">
    <span class="empty-icon">◎</span>
    <span class="empty-text">Sin actividad todavía</span>
  </div>
</div>

<div class="view" id="viewHistory" style="display:none">
  <div class="empty" id="emptyHistory">
    <span class="empty-icon">📋</span>
    <span class="empty-text">Sin conversaciones anteriores</span>
  </div>
</div>

<div class="footer">
  <div class="running-dot" id="runDot"></div>
  <button class="toggle-btn" id="toggleBtn">▶ Iniciar</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let isRunning = false;
  let currentTab = 'current';

  // ── State ──
  let currentConv = null;
  // { id, startTime, exchanges:[{prompt,promptTs,response,responseTs}], pendingPrompt:{text,ts}|null }
  let history = [];  // archived conversations, newest first

  // ── DOM refs ──
  const badge        = document.getElementById('badge');
  const badgeLabel   = document.getElementById('badgeLabel');
  const serverUrl    = document.getElementById('serverUrl');
  const runDot       = document.getElementById('runDot');
  const toggleBtn    = document.getElementById('toggleBtn');
  const viewCurrent  = document.getElementById('viewCurrent');
  const viewHistory  = document.getElementById('viewHistory');
  const histCount    = document.getElementById('histCount');
  const emptyCurrent = document.getElementById('emptyCurrent');
  const emptyHistory = document.getElementById('emptyHistory');

  const stateLabels = { idle: 'Idle', processing: 'Procesando', success: 'Listo', error: 'Error' };

  // ── Tab switching ──
  function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tabCurrent').className = 'tab' + (tab === 'current' ? ' active' : '');
    document.getElementById('tabHistory').className = 'tab' + (tab === 'history' ? ' active' : '');
    viewCurrent.style.display = tab === 'current' ? 'flex' : 'none';
    viewHistory.style.display = tab === 'history' ? 'flex' : 'none';
  }

  // ── Status ──
  function setStatus(state, url, running) {
    isRunning = running;
    badge.className = 'badge ' + state;
    badgeLabel.textContent = stateLabels[state] || state;
    if (url) { serverUrl.textContent = url; serverUrl.classList.remove('empty'); }
    runDot.className = 'running-dot' + (running ? ' on' : '');
    toggleBtn.className = 'toggle-btn' + (running ? ' stop' : '');
    toggleBtn.textContent = running ? '⏹ Detener' : '▶ Iniciar';
    toggleBtn.disabled = false;
  }

  // ── Helpers ──
  function trunc(text, max) {
    return text && text.length > max ? text.slice(0, max) + '…' : (text || '');
  }

  function makeBubble(cls, label, text, sm) {
    const div = document.createElement('div');
    div.className = 'bubble ' + cls + (sm ? ' sm' : '');
    const lbl = document.createElement('div');
    lbl.className = 'bubble-label';
    lbl.textContent = label;
    const txt = document.createElement('div');
    txt.className = 'bubble-text';
    txt.textContent = text;
    txt.title = text;
    div.appendChild(lbl);
    div.appendChild(txt);
    return div;
  }

  function makePendingBubble(promptText) {
    const div = document.createElement('div');
    div.className = 'bubble prompt';
    const lbl = document.createElement('div');
    lbl.className = 'bubble-label';
    lbl.textContent = 'Prompt';
    const txt = document.createElement('div');
    txt.className = 'bubble-text';
    txt.textContent = trunc(promptText, 300);
    const dots = document.createElement('div');
    dots.className = 'pending-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    div.appendChild(lbl);
    div.appendChild(txt);
    div.appendChild(dots);
    return div;
  }

  // ── Render current conversation ──
  function renderCurrentView() {
    Array.from(viewCurrent.children).forEach(c => { if (c !== emptyCurrent) c.remove(); });

    const hasContent = currentConv && (currentConv.exchanges.length > 0 || currentConv.pendingPrompt);
    emptyCurrent.style.display = hasContent ? 'none' : '';
    if (!hasContent) { return; }

    currentConv.exchanges.forEach(ex => {
      const wrap = document.createElement('div');
      wrap.className = 'exchange';
      wrap.appendChild(makeBubble('prompt',   'Prompt',    trunc(ex.prompt,   400)));
      wrap.appendChild(makeBubble('response', 'Respuesta', trunc(ex.response, 400)));
      viewCurrent.appendChild(wrap);
    });

    if (currentConv.pendingPrompt) {
      const wrap = document.createElement('div');
      wrap.className = 'exchange';
      wrap.appendChild(makePendingBubble(currentConv.pendingPrompt.text));
      viewCurrent.appendChild(wrap);
    }

    viewCurrent.scrollTop = viewCurrent.scrollHeight;
  }

  // ── Render history list ──
  function renderHistoryView() {
    Array.from(viewHistory.children).forEach(c => { if (c !== emptyHistory) c.remove(); });
    emptyHistory.style.display = history.length === 0 ? '' : 'none';

    history.forEach(conv => {
      const firstPrompt = conv.exchanges[0] ? conv.exchanges[0].prompt : '';
      const count = conv.exchanges.length;

      const item = document.createElement('div');
      item.className = 'hist-item';

      const header = document.createElement('div');
      header.className = 'hist-item-header';

      const arrow = document.createElement('span');
      arrow.className = 'hist-arrow';
      arrow.textContent = '▶';

      const meta = document.createElement('div');
      meta.className = 'hist-item-meta';

      const timeEl = document.createElement('div');
      timeEl.className = 'hist-item-time';
      timeEl.textContent = conv.startTime || '';

      const preview = document.createElement('div');
      preview.className = 'hist-item-preview';
      preview.textContent = trunc(firstPrompt, 55);
      preview.title = firstPrompt;

      meta.appendChild(timeEl);
      meta.appendChild(preview);

      const countEl = document.createElement('div');
      countEl.className = 'hist-item-count';
      countEl.textContent = count + (count === 1 ? ' intercambio' : ' intercambios');

      header.appendChild(arrow);
      header.appendChild(meta);
      header.appendChild(countEl);

      const body = document.createElement('div');
      body.className = 'hist-item-body';

      conv.exchanges.forEach(ex => {
        body.appendChild(makeBubble('prompt',   'P', trunc(ex.prompt,   250), true));
        body.appendChild(makeBubble('response', 'R', trunc(ex.response, 250), true));
      });

      header.addEventListener('click', () => item.classList.toggle('open'));

      item.appendChild(header);
      item.appendChild(body);
      viewHistory.appendChild(item);
    });
  }

  function updateHistBadge() {
    histCount.textContent = history.length;
    histCount.className = 'hist-count' + (history.length === 0 ? ' zero' : '');
  }

  // ── Conversation management ──
  function archiveCurrent() {
    if (currentConv && currentConv.exchanges.length > 0) {
      history.unshift(currentConv);
      updateHistBadge();
      renderHistoryView();
    }
    currentConv = null;
  }

  function handlePrompt(text, timestamp, conversationId, newChat) {
    const isNewConv = !currentConv
      || newChat === true
      || (conversationId && conversationId !== currentConv.id);

    if (isNewConv) {
      archiveCurrent();
      currentConv = { id: conversationId || null, startTime: timestamp, exchanges: [], pendingPrompt: null };
    }

    currentConv.pendingPrompt = { text: text, ts: timestamp };
    renderCurrentView();

    // Auto-switch to current tab when a new prompt arrives
    if (currentTab !== 'current') { switchTab('current'); }
  }

  function handleResponse(text, timestamp) {
    if (currentConv && currentConv.pendingPrompt) {
      currentConv.exchanges.push({
        prompt:     currentConv.pendingPrompt.text,
        promptTs:   currentConv.pendingPrompt.ts,
        response:   text,
        responseTs: timestamp
      });
      currentConv.pendingPrompt = null;
    }
    renderCurrentView();
  }

  // ── Model selector ──
  function onModelChange(family) {
    vscode.postMessage({ command: 'setModel', family });
  }

  // ── Controls ──
  toggleBtn.addEventListener('click', () => {
    toggleBtn.disabled = true;
    vscode.postMessage({ command: isRunning ? 'stop' : 'start' });
  });

  // ── Messages from extension host ──
  window.addEventListener('message', ({ data }) => {
    if (!data || !data.command) { return; }
    if (data.command === 'status') {
      setStatus(data.state, data.serverUrl, data.isRunning);
    }
    if (data.command === 'log') {
      if (data.type === 'prompt') {
        handlePrompt(data.text, data.timestamp, data.conversationId, data.newChat);
      } else if (data.type === 'response') {
        handleResponse(data.text, data.timestamp);
      }
    }
  });
</script>
</body>
</html>`;
    }
}
