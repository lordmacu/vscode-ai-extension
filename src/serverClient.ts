export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: Record<string, any>;
  };
}

export interface PromptData {
  prompt: string;
  newChat: boolean;
  saveLastMessageOnly: boolean;
  id: string | null;
  extractJson: boolean;
  modelFamily?: string;
  justification?: string;
  modelOptions?: Record<string, any>;
  systemPrompt?: string;
  maxInputTokens?: number;
  images?: string[];  // base64 data URLs: "data:image/png;base64,..."
  tools?: OpenAITool[]; // tool definitions (OpenAI format)
}

export interface SavePayload {
  text: string;
  prompt?: string;
  promptId?: string | null;
  extractJson?: boolean;
}

export class ServerClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private headers(extra?: Record<string, string>) {
    return { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey, ...extra };
  }

  // Long-polling: se queda esperando hasta 30s hasta que haya un prompt nuevo
  async waitForPrompt(): Promise<PromptData> {
    const res = await fetch(`${this.baseUrl}/api/prompt/wait`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(35000)   // 35s > 30s timeout del servidor
    });
    return res.json() as Promise<PromptData>;
  }

  async clearPrompt(): Promise<void> {
    await fetch(`${this.baseUrl}/api/prompt/clear`, {
      method: 'POST',
      headers: this.headers()
    });
  }

  async saveResponse(payload: SavePayload): Promise<void> {
    await fetch(`${this.baseUrl}/api/save`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload)
    });
  }

  // Reporta al servidor que Copilot quiere ejecutar un tool
  async reportToolCall(convId: string, callId: string, name: string, input: object): Promise<void> {
    await fetch(`${this.baseUrl}/api/tool/call`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ convId, callId, name, input })
    });
  }

  // Long-poll hasta 60s esperando que la app envíe el resultado del tool
  async waitForToolResult(callId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/tool/result/wait/${callId}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(65000)
    });
    if (!res.ok) {
      throw new Error(`Tool result error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json() as { result?: unknown; error?: string };
    if (data.error) { throw new Error(data.error); }
    return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
  }
}
