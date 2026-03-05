import * as vscode from 'vscode';
import { Poller, StatusState } from './poller';

export class AiRunnerProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiRunner.panel';
    private _view?: vscode.WebviewView;
    private _poller?: Poller;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'start') { this._startPoller(); }
            else if (msg.command === 'stop') { this._stopPoller(); }
            else if (msg.command === 'clearAll') { await this._clearAll(); }
            else if (msg.command === 'ready') {
                const { serverUrl } = this._getConfig();
                const savedHistory = this._context.globalState.get<any[]>('aiRunnerHistory', []);
                this._post({ command: 'init', serverUrl, savedHistory });
            }
            else if (msg.command === 'saveHistory') {
                const entries = (msg.history || []).slice(0, 100);
                await this._context.globalState.update('aiRunnerHistory', entries);
            }
            else if (msg.command === 'setServerUrl') {
                let url = (msg.url || '').trim();
                while (url.endsWith('/')) { url = url.slice(0, -1); }
                if (!url) { return; }
                await vscode.workspace.getConfiguration('aiRunner').update('serverUrl', url, vscode.ConfigurationTarget.Global);
                if (this._poller?.running) {
                    this._poller.dispose();
                    this._poller = undefined;
                    this._startPoller();
                }
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
                    newChat: extra?.newChat,
                    modelFamily: extra?.modelFamily,
                    workerId: extra?.workerId,
                    elapsed: extra?.elapsed,
                });
            }
        });
        this._poller.modelFamily = 'gpt-4.1';
        this._poller.timeoutMs = vscode.workspace.getConfiguration('aiRunner').get<number>('timeoutSeconds', 120) * 1000;
        this._poller.start();
    }

    private _stopPoller() {
        this._poller?.stop();
    }

    private async _clearAll() {
        const { serverUrl, apiKey } = this._getConfig();
        try {
            await fetch(`${serverUrl}/api/prompt/clear`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
                body: JSON.stringify({ cancel: true })
            });
        } catch (_) {}
        await this._context.globalState.update('aiRunnerHistory', []);
        this._post({ command: 'clearAllDone' });
    }

    public startPoller()   { this._startPoller(); }
    public stopPoller()    { this._stopPoller(); }
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
  .badge.offline      { background: rgba(255,152,0,.15); color: #ffb300; }
  .badge.offline .dot { background: #ffb300; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.7)} }
  .server-row { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }
  .server-label { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .server-input {
    flex: 1; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px; padding: 2px 5px; outline: none; min-width: 0;
  }
  .server-input:focus { border-color: var(--vscode-focusBorder); }
  .server-save-btn {
    font-size: 10px; padding: 2px 6px; border-radius: 3px; border: none; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    flex-shrink: 0; display: none;
  }
  .server-save-btn.visible { display: block; }
  .model-hint { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: .7; }

  /* ── LOG PANEL ── */
  .log-panel { flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .log-toggle {
    display: flex; align-items: center; gap: 5px; padding: 4px 12px;
    cursor: pointer; user-select: none; background: none; border: none; width: 100%;
    font-family: inherit; color: var(--vscode-descriptionForeground);
  }
  .log-toggle:hover { background: var(--vscode-list-hoverBackground); }
  .log-arrow { font-size: 8px; transition: transform .15s; }
  .log-panel.open .log-arrow { transform: rotate(90deg); }
  .log-toggle-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; flex: 1; text-align: left; }
  .log-err-dot { width: 6px; height: 6px; border-radius: 50%; background: #f48771; display: none; flex-shrink: 0; }
  .log-err-dot.visible { display: block; }
  .log-body { display: none; max-height: 120px; overflow-y: auto; padding: 4px 8px 6px; }
  .log-panel.open .log-body { display: block; }
  .log-body::-webkit-scrollbar { width: 4px; }
  .log-body::-webkit-scrollbar-thumb { background: rgba(128,128,128,.3); border-radius: 2px; }
  .log-line {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
    line-height: 1.5; word-break: break-all; padding: 1px 0;
    color: var(--vscode-descriptionForeground);
  }
  .log-line.err { color: #f48771; }
  .log-line.info { opacity: .75; }

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

  /* ── BUBBLES ── */
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
  .bubble.response.error { background: rgba(229,83,75,.08); border-left-color: #f48771; }
  .bubble.response.error .bubble-label { color: #f48771; }

  /* ── PENDING ANIMATION ── */
  .pending-dots { display: inline-flex; gap: 3px; align-items: center; margin-top: 4px; }
  .pending-dots span {
    width: 5px; height: 5px; border-radius: 50%; background: #4fc3f7;
    animation: bounce 1.2s ease-in-out infinite;
  }
  .pending-dots span:nth-child(2) { animation-delay: .2s; }
  .pending-dots span:nth-child(3) { animation-delay: .4s; }
  @keyframes bounce { 0%,80%,100%{transform:scale(.6)} 40%{transform:scale(1)} }

  /* ── CONV CARDS (Actual tab) ── */
  .conv-item { border-radius: 4px; border: 1px solid rgba(0,122,204,.35); overflow: hidden; margin-bottom: 4px; }
  .conv-item-header {
    display: flex; align-items: center; gap: 6px; padding: 6px 8px;
    cursor: pointer; background: var(--vscode-input-background); user-select: none;
  }
  .conv-item-header:hover { background: var(--vscode-list-hoverBackground); }
  .conv-arrow { font-size: 9px; opacity: .6; flex-shrink: 0; transition: transform .15s; }
  .conv-item.open .conv-arrow { transform: rotate(90deg); }
  .conv-item-meta { flex: 1; min-width: 0; }
  .conv-item-time { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: .7; }
  .conv-item-preview { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .9; }
  .conv-item-badge { font-size: 9px; flex-shrink: 0; padding: 1px 6px; border-radius: 8px; font-weight: 600; }
  .conv-item-badge.processing { background: rgba(0,122,204,.2); color: #4fc3f7; }
  .conv-item-badge.done { background: rgba(76,175,80,.15); color: #4caf50; }
  .conv-item-body {
    display: none; padding: 6px 8px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-direction: column; gap: 3px;
  }
  .conv-item.open .conv-item-body { display: flex; }

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
  .clear-btn {
    padding: 6px 8px; background: none; border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground); border-radius: 3px; cursor: pointer;
    font-size: 13px; line-height: 1; transition: background .15s, color .15s; flex-shrink: 0;
  }
  .clear-btn:hover { background: rgba(229,83,75,.15); color: #f48771; border-color: #f48771; }
  .clear-btn:disabled { opacity: .35; cursor: not-allowed; }
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
    <input class="server-input" id="serverInput" type="text" placeholder="https://..." spellcheck="false" />
    <button class="server-save-btn" id="serverSaveBtn" onclick="saveServerUrl()">Guardar</button>
  </div>
  <div class="server-row" style="margin-bottom:0">
    <span class="server-label">Model:</span>
    <span class="model-hint">por peticion (default: gpt-4.1)</span>
  </div>
</div>

<div class="log-panel" id="logPanel">
  <button class="log-toggle" onclick="toggleLogPanel()">
    <span class="log-arrow" id="logArrow">&#9654;</span>
    <span class="log-toggle-label">Logs</span>
    <span class="log-err-dot" id="logErrDot"></span>
  </button>
  <div class="log-body" id="logBody"></div>
</div>

<div class="tabs">
  <button class="tab active" id="tabCurrent" onclick="switchTab('current')">Actual</button>
  <button class="tab" id="tabHistory" onclick="switchTab('history')">
    Historial <span class="hist-count zero" id="histCount">0</span>
  </button>
</div>

<div class="view" id="viewCurrent">
  <div class="empty" id="emptyCurrent">
    <span class="empty-icon">&#9678;</span>
    <span class="empty-text">Sin actividad todavía</span>
  </div>
</div>

<div class="view" id="viewHistory" style="display:none">
  <div class="empty" id="emptyHistory">
    <span class="empty-icon">&#128203;</span>
    <span class="empty-text">Sin conversaciones anteriores</span>
  </div>
</div>

<div class="footer">
  <div class="running-dot" id="runDot"></div>
  <button class="toggle-btn" id="toggleBtn">&#9654; Iniciar</button>
  <button class="clear-btn" id="clearBtn" title="Cancelar prompts y limpiar" disabled>&#128465;</button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let isRunning = false;
  let currentTab = 'current';
  let activeConvs = new Map();
  let convHistory = [];

  const badge        = document.getElementById('badge');
  const badgeLabel   = document.getElementById('badgeLabel');
  const serverInput  = document.getElementById('serverInput');
  const serverSaveBtn= document.getElementById('serverSaveBtn');
  const runDot       = document.getElementById('runDot');
  const toggleBtn    = document.getElementById('toggleBtn');
  const clearBtn     = document.getElementById('clearBtn');
  const viewCurrent  = document.getElementById('viewCurrent');
  const viewHistory  = document.getElementById('viewHistory');
  const histCount    = document.getElementById('histCount');
  const emptyCurrent = document.getElementById('emptyCurrent');
  const emptyHistory = document.getElementById('emptyHistory');
  const logPanel     = document.getElementById('logPanel');
  const logBody      = document.getElementById('logBody');
  const logErrDot    = document.getElementById('logErrDot');

  var logLines = [];
  var MAX_LOG = 80;
  var stateLabels = { idle: 'Idle', processing: 'Procesando', success: 'Listo', error: 'Error', offline: 'Sin conexion' };

  function toggleLogPanel() {
    logPanel.classList.toggle('open');
    if (logPanel.classList.contains('open')) {
      logErrDot.classList.remove('visible');
      logBody.scrollTop = logBody.scrollHeight;
    }
  }

  function appendLog(type, text) {
    var ts = new Date().toLocaleTimeString('es-MX', { hour12: false });
    var line = document.createElement('div');
    line.className = 'log-line ' + (type === 'error' ? 'err' : 'info');
    line.textContent = ts + '  ' + text;
    line.title = text;
    logBody.appendChild(line);
    logLines.push(line);
    if (logLines.length > MAX_LOG) { logLines.shift().remove(); }
    if (logPanel.classList.contains('open')) {
      logBody.scrollTop = logBody.scrollHeight;
    } else if (type === 'error') {
      logErrDot.classList.add('visible');
    }
  }

  function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tabCurrent').className = 'tab' + (tab === 'current' ? ' active' : '');
    document.getElementById('tabHistory').className = 'tab' + (tab === 'history' ? ' active' : '');
    viewCurrent.style.display = tab === 'current' ? 'flex' : 'none';
    viewHistory.style.display = tab === 'history' ? 'flex' : 'none';
  }

  function setStatus(state, url, running) {
    isRunning = running;
    badge.className = 'badge ' + state;
    badgeLabel.textContent = stateLabels[state] || state;
    runDot.className = 'running-dot' + (running ? ' on' : '');
    toggleBtn.className = 'toggle-btn' + (running ? ' stop' : '');
    toggleBtn.textContent = running ? '\u23f9 Detener' : '\u25b6 Iniciar';
    toggleBtn.disabled = false;
    clearBtn.disabled = !running;
  }

  serverInput.addEventListener('input', function() {
    serverSaveBtn.classList.toggle('visible', serverInput.value.trim() !== '');
  });

  serverInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { saveServerUrl(); }
    if (e.key === 'Escape') { serverInput.blur(); }
  });

  function saveServerUrl() {
    var url = serverInput.value.trim();
    while (url.length > 0 && url[url.length - 1] === '/') { url = url.slice(0, -1); }
    if (!url) { return; }
    serverSaveBtn.classList.remove('visible');
    serverSaveBtn.textContent = '\u2713';
    setTimeout(function() { serverSaveBtn.textContent = 'Guardar'; }, 1500);
    vscode.postMessage({ command: 'setServerUrl', url: url });
  }

  function trunc(text, max) {
    return text && text.length > max ? text.slice(0, max) + '\u2026' : (text || '');
  }

  function makeBubble(cls, label, text, sm) {
    var div = document.createElement('div');
    div.className = 'bubble ' + cls + (sm ? ' sm' : '');
    var lbl = document.createElement('div');
    lbl.className = 'bubble-label';
    lbl.textContent = label;
    var txt = document.createElement('div');
    txt.className = 'bubble-text';
    txt.textContent = text;
    txt.title = text;
    div.appendChild(lbl);
    div.appendChild(txt);
    return div;
  }

  function makePendingBubble(promptText) {
    var div = document.createElement('div');
    div.className = 'bubble prompt';
    var lbl = document.createElement('div');
    lbl.className = 'bubble-label';
    lbl.textContent = 'Prompt';
    var txt = document.createElement('div');
    txt.className = 'bubble-text';
    txt.textContent = trunc(promptText, 300);
    var dots = document.createElement('div');
    dots.className = 'pending-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    div.appendChild(lbl);
    div.appendChild(txt);
    div.appendChild(dots);
    return div;
  }

  function renderCurrentView() {
    Array.from(viewCurrent.children).forEach(function(c) { if (c !== emptyCurrent) c.remove(); });
    var hasContent = activeConvs.size > 0;
    emptyCurrent.style.display = hasContent ? 'none' : '';
    if (!hasContent) { return; }

    activeConvs.forEach(function(conv) {
      var isProcessing = !!conv.pendingPrompt;
      var firstPrompt = conv.pendingPrompt ? conv.pendingPrompt.text : (conv.exchanges[0] ? conv.exchanges[0].prompt : '');

      var item = document.createElement('div');
      item.className = 'conv-item open';

      var header = document.createElement('div');
      header.className = 'conv-item-header';

      var arrow = document.createElement('span');
      arrow.className = 'conv-arrow';
      arrow.textContent = '\u25b6';

      var meta = document.createElement('div');
      meta.className = 'conv-item-meta';

      var timeEl = document.createElement('div');
      timeEl.className = 'conv-item-time';
      var timeText = conv.startTime || '';
      if (conv.id) { timeText = 'ID: ' + conv.id.slice(-12) + '  ' + timeText; }
      if (conv.modelFamily) { timeText = timeText + '  \u00b7 ' + conv.modelFamily; }
      timeEl.textContent = timeText;

      var preview = document.createElement('div');
      preview.className = 'conv-item-preview';
      preview.textContent = trunc(firstPrompt, 55);
      preview.title = firstPrompt;

      meta.appendChild(timeEl);
      meta.appendChild(preview);

      var statusBadge = document.createElement('span');
      statusBadge.className = 'conv-item-badge ' + (isProcessing ? 'processing' : 'done');
      statusBadge.textContent = isProcessing ? '\u23f3' : '\u2713';

      header.appendChild(arrow);
      header.appendChild(meta);
      header.appendChild(statusBadge);
      header.addEventListener('click', function() { item.classList.toggle('open'); });

      var body = document.createElement('div');
      body.className = 'conv-item-body';

      conv.exchanges.forEach(function(ex) {
        body.appendChild(makeBubble('prompt', 'Prompt', trunc(ex.prompt, 400)));
        var respCls = 'response' + (ex.isError ? ' error' : '');
        body.appendChild(makeBubble(respCls, ex.isError ? 'Error' : 'Respuesta', trunc(ex.response, 400)));
      });

      if (conv.pendingPrompt) {
        body.appendChild(makePendingBubble(conv.pendingPrompt.text));
      }

      item.appendChild(header);
      item.appendChild(body);
      viewCurrent.appendChild(item);
    });

    viewCurrent.scrollTop = viewCurrent.scrollHeight;
  }

  function makeHistItem(conv) {
    var firstPrompt = conv.exchanges[0] ? conv.exchanges[0].prompt : '';
    var count = conv.exchanges.length;

    var item = document.createElement('div');
    item.className = 'hist-item';

    var header = document.createElement('div');
    header.className = 'hist-item-header';

    var arrow = document.createElement('span');
    arrow.className = 'hist-arrow';
    arrow.textContent = '\u25b6';

    var meta = document.createElement('div');
    meta.className = 'hist-item-meta';

    var timeEl = document.createElement('div');
    timeEl.className = 'hist-item-time';
    var timeText = conv.startTime || '';
    if (conv.modelFamily) { timeText = timeText + '  \u00b7 ' + conv.modelFamily; }
    timeEl.textContent = timeText;

    var preview = document.createElement('div');
    preview.className = 'hist-item-preview';
    preview.textContent = trunc(firstPrompt, 55);
    preview.title = firstPrompt || '';

    meta.appendChild(timeEl);
    meta.appendChild(preview);

    var countEl = document.createElement('div');
    countEl.className = 'hist-item-count';
    countEl.textContent = count + (count === 1 ? ' intercambio' : ' intercambios');

    header.appendChild(arrow);
    header.appendChild(meta);
    header.appendChild(countEl);
    header.addEventListener('click', function() { item.classList.toggle('open'); });

    var body = document.createElement('div');
    body.className = 'hist-item-body';
    conv.exchanges.forEach(function(ex) {
      var elLabel = ex.elapsed ? ' ' + ex.elapsed + 'ms' : '';
      body.appendChild(makeBubble('prompt',   'P', trunc(ex.prompt,   250), true));
      body.appendChild(makeBubble('response', 'R' + elLabel, trunc(ex.response, 250), true));
    });

    item.appendChild(header);
    item.appendChild(body);
    return item;
  }

  function prependHistoryItem(conv) {
    emptyHistory.style.display = 'none';
    var item = makeHistItem(conv);
    var first = viewHistory.children[1];
    if (first) { viewHistory.insertBefore(item, first); }
    else { viewHistory.appendChild(item); }
  }

  function renderHistoryView() {
    Array.from(viewHistory.children).forEach(function(c) { if (c !== emptyHistory) c.remove(); });
    emptyHistory.style.display = convHistory.length === 0 ? '' : 'none';
    convHistory.forEach(function(conv) { viewHistory.appendChild(makeHistItem(conv)); });
  }

  function updateHistBadge() {
    histCount.textContent = convHistory.length;
    histCount.className = 'hist-count' + (convHistory.length === 0 ? ' zero' : '');
  }

  var saveHistTimer = null;
  function scheduleSaveHistory() {
    if (saveHistTimer) { clearTimeout(saveHistTimer); }
    saveHistTimer = setTimeout(function() {
      saveHistTimer = null;
      vscode.postMessage({ command: 'saveHistory', history: convHistory });
    }, 500);
  }

  function archiveConv(convId) {
    var key = convId || '__anon__';
    var conv = activeConvs.get(key);
    if (conv && conv.exchanges.length > 0) {
      var entry = {
        id: conv.id,
        startTime: conv.startTime,
        modelFamily: conv.modelFamily,
        exchanges: conv.exchanges.map(function(ex) {
          return {
            prompt:     ex.prompt     ? ex.prompt.slice(0, 500)   : '',
            promptTs:   ex.promptTs,
            response:   ex.response   ? ex.response.slice(0, 2000) : '',
            responseTs: ex.responseTs,
            elapsed:    ex.elapsed || null,
            isError:    ex.isError || false
          };
        })
      };
      convHistory.unshift(entry);
      if (convHistory.length > 100) { convHistory.length = 100; }
      updateHistBadge();
      prependHistoryItem(entry);
      scheduleSaveHistory();
    }
    activeConvs.delete(key);
  }

  function handlePrompt(text, timestamp, conversationId, newChat, modelFamily) {
    var key = conversationId || '__anon__';
    if (newChat && activeConvs.has(key)) { archiveConv(key); }

    if (!activeConvs.has(key)) {
      if (!newChat && conversationId) {
        var histIdx = convHistory.findIndex(function(c) { return c.id === conversationId; });
        if (histIdx !== -1) {
          var existing = convHistory.splice(histIdx, 1)[0];
          activeConvs.set(key, existing);
          updateHistBadge();
          renderHistoryView();
        } else {
          activeConvs.set(key, { id: conversationId, startTime: timestamp, exchanges: [], pendingPrompt: null, modelFamily: modelFamily || null });
        }
      } else {
        activeConvs.set(key, { id: conversationId || null, startTime: timestamp, exchanges: [], pendingPrompt: null, modelFamily: modelFamily || null });
      }
    }

    var conv = activeConvs.get(key);
    if (modelFamily) { conv.modelFamily = modelFamily; }
    conv.pendingPrompt = { text: text, ts: timestamp };
    renderCurrentView();
    if (currentTab !== 'current') { switchTab('current'); }
  }

  function handleResponse(text, timestamp, conversationId, elapsed) {
    var key = conversationId || '__anon__';
    var conv = activeConvs.get(key);
    if (conv && conv.pendingPrompt) {
      conv.exchanges.push({
        prompt:     conv.pendingPrompt.text,
        promptTs:   conv.pendingPrompt.ts,
        response:   text,
        responseTs: timestamp,
        elapsed:    elapsed || null
      });
      conv.pendingPrompt = null;
    }
    renderCurrentView();
    setTimeout(function() { archiveConv(key); renderCurrentView(); }, 4000);
  }

  function handleError(errorText, conversationId) {
    var key = conversationId || '__anon__';
    var conv = activeConvs.get(key);
    if (conv && conv.pendingPrompt) {
      conv.exchanges.push({
        prompt:     conv.pendingPrompt.text,
        promptTs:   conv.pendingPrompt.ts,
        response:   '\u26a0\ufe0f ' + errorText,
        responseTs: new Date().toLocaleTimeString('es-MX', { hour12: false }),
        isError:    true
      });
      conv.pendingPrompt = null;
    }
    renderCurrentView();
    setTimeout(function() { archiveConv(key); renderCurrentView(); }, 6000);
  }

  toggleBtn.addEventListener('click', function() {
    toggleBtn.disabled = true;
    vscode.postMessage({ command: isRunning ? 'stop' : 'start' });
  });

  clearBtn.addEventListener('click', function() {
    activeConvs.clear();
    convHistory = [];
    updateHistBadge();
    renderCurrentView();
    renderHistoryView();
    vscode.postMessage({ command: 'clearAll' });
  });

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || !data.command) { return; }
    if (data.command === 'init') {
      serverInput.value = data.serverUrl || '';
      if (data.savedHistory && data.savedHistory.length > 0) {
        convHistory = data.savedHistory;
        updateHistBadge();
        renderHistoryView();
      }
    }
    if (data.command === 'status') {
      setStatus(data.state, data.serverUrl, data.isRunning);
    }
    if (data.command === 'clearAllDone') {
      activeConvs.clear();
      convHistory = [];
      updateHistBadge();
      renderCurrentView();
      renderHistoryView();
    }
    if (data.command === 'log') {
      var wLabel = data.workerId !== undefined ? 'W' + data.workerId + ' ' : '';
      if (data.type === 'prompt') {
        var mLabel = data.modelFamily ? ' [' + data.modelFamily + ']' : '';
        appendLog('info', wLabel + '\u2192' + mLabel + ' [' + (data.conversationId || 'anon') + '] ' + data.text.slice(0, 70));
        handlePrompt(data.text, data.timestamp, data.conversationId, data.newChat, data.modelFamily);
      } else if (data.type === 'response') {
        var elLabel = data.elapsed ? ' ' + data.elapsed + 'ms' : '';
        var chLabel = ' ' + data.text.length + 'c';
        appendLog('info', wLabel + '\u2190 [' + (data.conversationId || 'anon') + '] OK' + chLabel + elLabel);
        handleResponse(data.text, data.timestamp, data.conversationId, data.elapsed);
      } else if (data.type === 'error') {
        appendLog('error', wLabel + data.text);
        handleError(data.text, data.conversationId);
      } else if (data.type === 'info') {
        appendLog('info', data.text);
      }
    }
  });

  vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
    }
}
