import WebSocket from 'ws';
import { ServerClient } from './serverClient';
import { executePrompt } from './executor';

export type StatusState = 'idle' | 'processing' | 'success' | 'error';

export interface LogExtra {
  conversationId?: string | null;
  newChat?: boolean;
}

export interface PollerCallbacks {
  onStatus: (state: StatusState, isRunning: boolean) => void;
  onLog: (type: 'prompt' | 'response' | 'error' | 'info', text: string, extra?: LogExtra) => void;
}

export class Poller {
  private active = false;
  private ws: WebSocket | null = null;
  private lastTaskId: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private client: ServerClient;
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
    this.cb.onLog('info', `WebSocket iniciado → ${this.serverUrl}`);
    this.connect();
  }

  stop() {
    this.active = false;
    this.clearReconnect();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this.cb.onStatus('idle', false);
    this.cb.onLog('info', 'WebSocket detenido');
  }

  dispose() { this.stop(); }

  private connect() {
    if (!this.active) { return; }

    // Construir URL WebSocket: https→wss, http→ws
    const wsUrl = this.serverUrl.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/ws?key=' + encodeURIComponent(this.apiKey);

    let socket: WebSocket;
    try {
      socket = new (WebSocket as any)(wsUrl);
      this.ws = socket;
    } catch (err) {
      this.scheduleReconnect();
      return;
    }

    socket.on('open', () => {
      this.cb.onLog('info', 'WebSocket conectado');
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'connected') { return; }
        if (msg.type === 'prompt') { this.handlePrompt(msg); }
      } catch (_) {}
    });

    socket.on('close', () => {
      this.ws = null;
      if (this.active) {
        this.cb.onLog('info', 'WebSocket desconectado, reconectando…');
        this.scheduleReconnect();
      }
    });

    socket.on('error', (err: Error) => {
      if (!err.message.includes('ECONNREFUSED') && !err.message.includes('ENOTFOUND')) {
        this.cb.onLog('error', `WS: ${err.message}`);
      }
    });

    socket.on('pong', () => { /* keep-alive */ });
  }

  private async handlePrompt(data: {
    prompt: string;
    newChat: boolean;
    id: string | null;
    extractJson: boolean;
    taskId: number | null;
    modelFamily?: string;
    justification?: string;
    modelOptions?: Record<string, any>;
    systemPrompt?: string;
    maxInputTokens?: number;
  }) {
    const prompt = (data.prompt || '').trim();
    if (!prompt) { return; }
    if (data.taskId === this.lastTaskId) { return; }

    this.lastTaskId = data.taskId;
    this.cb.onStatus('processing', true);
    this.cb.onLog('prompt', prompt, { conversationId: data.id, newChat: data.newChat });

    const TIMEOUT_MS = 120000; // 2min — alineado con el timeout del servidor
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout: el prompt tardó más de 2 minutos')), TIMEOUT_MS)
    );

    let responseText: string;
    try {
      responseText = await Promise.race([
        executePrompt(prompt, data.id, data.newChat, {
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
      this.cb.onLog('error', msg);
      this.cb.onStatus('error', true);
      await this.client.clearPrompt();
      setTimeout(() => { if (this.active) { this.cb.onStatus('idle', true); } }, 3000);
      return;
    }

    await this.client.saveResponse({
      text: responseText,
      prompt,
      promptId: data.id,
      extractJson: data.extractJson
    });
    await this.client.clearPrompt();

    this.cb.onLog('response', responseText);
    this.cb.onStatus('success', true);
    setTimeout(() => { if (this.active) { this.cb.onStatus('idle', true); } }, 3000);
  }

  private scheduleReconnect() {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      if (this.active) { this.connect(); }
    }, 3000);
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
