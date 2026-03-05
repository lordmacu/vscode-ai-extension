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
  images?: string[]; // base64 data URLs: "data:image/png;base64,..."
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
}
