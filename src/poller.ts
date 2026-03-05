import WebSocket from 'ws';
import { ServerClient } from './serverClient';
import { executePrompt } from './executor';

export type StatusState = 'idle' | 'processing' | 'success' | 'error';

export interface LogExtra {
  conversationId?: string | null;
  newChat?: boolean;
  modelFamily?: string;
  workerId?: number;
  elapsed?: number;
}

export interface PollerCallbacks {
  onStatus: (state: StatusState, isRunning: boolean) => void;
  onLog: (type: 'prompt' | 'response' | 'error' | 'info', text: string, extra?: LogExtra) => void;
}

const WORKER_COUNT = 3; // workers paralelos

export class Poller {
  private active = false;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private client: ServerClient;
  private activeConvIds = new Set<string>(); // guard de deduplicación
  public modelFamily: string = 'gpt-4.1';

  constructor(
    private serverUrl: string,
    private apiKey: string,
    private cb: PollerCallbacks
  ) {
    this.client = new ServerClient(serverUrl, apiKey);
  }

  get running() { return this.active; }

  start() {
    if (this.active) { return; }
    this.active = true;
    this.cb.onStatus('idle', true);
    this.cb.onLog('info', `Iniciando ${WORKER_COUNT} workers → ${this.serverUrl}`);

    // Conectar WebSocket solo para recibir actualizaciones de estado
    this.connectWs();

    // Lanzar N workers paralelos de long-polling
    for (let i = 0; i < WORKER_COUNT; i++) {
      this.runWorker(i);
    }
  }

  stop() {
    this.active = false;
    this.clearReconnect();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this.cb.onStatus('idle', false);
    this.cb.onLog('info', 'Workers detenidos');
  }

  dispose() { this.stop(); }

  // ─── Worker loop ─────────────────────────────────────────────────────────────
  private async runWorker(workerId: number) {
    while (this.active) {
      try {
        const data = await this.client.waitForPrompt();
        if (!this.active) { break; }

        const prompt = (data.prompt || '').trim();
        if (!prompt) { continue; } // timeout del servidor — volver a esperar

        await this.handlePrompt(data, workerId);
      } catch (err) {
        if (!this.active) { break; }
        // Error de red — esperar un poco antes de reintentar
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ENOTFOUND') && !msg.includes('timeout')) {
          this.cb.onLog('error', `Worker ${workerId}: ${msg}`);
        }
        await this.sleep(3000);
      }
    }
  }

  // ─── Procesar un prompt individual ───────────────────────────────────────────
  private async handlePrompt(data: {
    prompt: string;
    newChat: boolean;
    id: string | null;
    extractJson: boolean;
    saveLastMessageOnly?: boolean;
    modelFamily?: string;
    justification?: string;
    modelOptions?: Record<string, any>;
    systemPrompt?: string;
    maxInputTokens?: number;
  }, workerId: number) {
    const prompt = (data.prompt || '').trim();
    const convId = data.id;

    // Evitar doble procesamiento si dos workers recibieran el mismo convId (no debería pasar)
    if (convId && this.activeConvIds.has(convId)) {
      return;
    }
    if (convId) { this.activeConvIds.add(convId); }

    this.cb.onStatus('processing', true);
    this.cb.onLog('prompt', prompt, { conversationId: convId, newChat: data.newChat, modelFamily: data.modelFamily ?? this.modelFamily, workerId });

    const TIMEOUT_MS = 120000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout: el prompt tardó más de 2 minutos')), TIMEOUT_MS)
    );

    const startMs = Date.now();
    let responseText: string;
    try {
      responseText = await Promise.race([
        executePrompt(prompt, convId, data.newChat, {
          modelFamily:    data.modelFamily    ?? this.modelFamily,
          justification:  data.justification,
          modelOptions:   data.modelOptions,
          systemPrompt:   data.systemPrompt,
          maxInputTokens: data.maxInputTokens,
        }),
        timeout
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cb.onLog('error', msg, { conversationId: convId, workerId });
      this.cb.onStatus('error', true);
      if (convId) { this.activeConvIds.delete(convId); }
      setTimeout(() => { if (this.active) { this.cb.onStatus('idle', true); } }, 3000);
      return;
    }

    const elapsed = Date.now() - startMs;

    await this.client.saveResponse({
      text: responseText,
      prompt,
      promptId: convId,
      extractJson: data.extractJson
    });

    this.cb.onLog('response', responseText, { conversationId: convId, workerId, elapsed });
    this.cb.onStatus('success', true);
    if (convId) { this.activeConvIds.delete(convId); }
    setTimeout(() => { if (this.active) { this.cb.onStatus('idle', true); } }, 3000);
  }

  // ─── WebSocket para actualizaciones de estado (no prompts) ───────────────────
  private connectWs() {
    if (!this.active) { return; }
    const wsUrl = this.serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/ws?key=' + encodeURIComponent(this.apiKey);

    let socket: WebSocket;
    try {
      socket = new (WebSocket as any)(wsUrl);
      this.ws = socket;
    } catch {
      this.scheduleWsReconnect();
      return;
    }

    socket.on('open', () => {
      this.cb.onLog('info', 'WebSocket conectado (estado)');
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Solo recibimos mensajes de estado — los prompts llegan via long-poll
        if (msg.type === 'connected' || msg.type === 'status') { return; }
      } catch (_) {}
    });

    socket.on('close', () => {
      this.ws = null;
      if (this.active) { this.scheduleWsReconnect(); }
    });

    socket.on('error', (err: Error) => {
      if (!err.message.includes('ECONNREFUSED') && !err.message.includes('ENOTFOUND')) {
        this.cb.onLog('error', `WS: ${err.message}`);
      }
    });

    socket.on('pong', () => { /* keep-alive */ });
  }

  private scheduleWsReconnect() {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      if (this.active) { this.connectWs(); }
    }, 5000);
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
