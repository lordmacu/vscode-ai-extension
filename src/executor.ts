import * as vscode from 'vscode';
import type { OpenAITool } from './serverClient';

// Historial de conversaciones: conversationId → mensajes acumulados
const history = new Map<string, vscode.LanguageModelChatMessage[]>();

// CancellationTokenSources activos — para cancelar prompts en progreso
const activeCts = new Set<vscode.CancellationTokenSource>();

export function cancelAllPrompts() {
  activeCts.forEach(cts => cts.cancel());
}

export interface ExecuteOptions {
  modelFamily?: string;
  justification?: string;
  modelOptions?: Record<string, any>;
  systemPrompt?: string;
  maxInputTokens?: number; // truncar historial si supera este límite
  images?: string[];       // base64 data URLs adjuntas al mensaje del usuario
  tools?: OpenAITool[];    // tool definitions (OpenAI format) — habilita tool calling
  onToolCall?: (callId: string, name: string, input: object) => Promise<string>;
}

export async function executePrompt(
  prompt: string,
  conversationId: string | null,
  newChat: boolean,
  options: ExecuteOptions = {}
): Promise<string> {
  const {
    modelFamily = 'gpt-4.1',
    justification,
    modelOptions = {},
    systemPrompt,
    maxInputTokens,
    images = [],
    tools = [],
    onToolCall,
  } = options;

  // Seleccionar modelo con fallbacks
  let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: modelFamily });
  if (!models.length) { models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4.1' }); }
  if (!models.length) { models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' }); }
  if (!models.length) { models = await vscode.lm.selectChatModels(); }

  const model = models[0];
  if (!model) {
    throw new Error('No hay modelos disponibles. Asegúrate de tener GitHub Copilot activo.');
  }

  // Determinar clave de conversación
  const key = conversationId ?? '__standalone__';

  // Si newChat o sin id → limpiar historial
  if (newChat || !conversationId) {
    history.delete(key);
  }

  const messages = history.get(key) ?? [];

  // Inyectar systemPrompt como primer mensaje de usuario si es chat nuevo
  if (systemPrompt && messages.length === 0) {
    messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
    messages.push(vscode.LanguageModelChatMessage.Assistant('Entendido.'));
  }

  console.log(`[AI Runner] executePrompt images: ${images.length}`);
  const userParts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [
    new vscode.LanguageModelTextPart(prompt),
    ...images.map((url, i) => {
      const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
      const mime = (match?.[1] ?? 'image/png') as `image/${string}`;
      const bytes = Buffer.from(match?.[2] ?? url, 'base64');
      console.log(`[AI Runner] image[${i}]: mime=${mime} bytes=${bytes.length}`);
      return new vscode.LanguageModelDataPart(bytes, mime);
    }),
  ];
  console.log(`[AI Runner] userParts count: ${userParts.length}`);
  messages.push(vscode.LanguageModelChatMessage.User(userParts));

  // Truncar historial si supera el límite de tokens
  if (maxInputTokens && messages.length > 2) {
    await truncateHistoryByTokens(model, messages, maxInputTokens);
  }

  const cts = new vscode.CancellationTokenSource();
  activeCts.add(cts);

  // Convertir tools OpenAI format → VS Code LanguageModelChatTool
  const lmTools: vscode.LanguageModelChatTool[] = tools
    .filter(t => t.type === 'function' && t.function?.name)
    .map(t => ({
      name:        t.function.name,
      description: t.function.description ?? '',
      inputSchema: (t.function.parameters ?? {}) as vscode.LanguageModelChatTool['inputSchema'],
    }));

  const requestOptions: vscode.LanguageModelChatRequestOptions = {};
  if (justification)                                { requestOptions.justification = justification; }
  if (modelOptions && Object.keys(modelOptions).length) { requestOptions.modelOptions  = modelOptions; }
  if (lmTools.length)                               { requestOptions.tools = lmTools; }

  let fullText = '';
  try {
    // Loop de tool calling: continúa hasta que Copilot no pida más tools
    while (true) {
      const response = await model.sendRequest(messages, requestOptions, cts.token);

      const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      let iterText = '';

      for await (const chunk of response.stream) {
        if (cts.token.isCancellationRequested) { throw new Error('__cancelled__'); }
        if (chunk instanceof vscode.LanguageModelTextPart) {
          assistantParts.push(chunk);
          iterText += chunk.value;
        } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
          assistantParts.push(chunk);
        }
      }

      const toolCallParts = assistantParts.filter(
        (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
      );

      if (toolCallParts.length === 0 || !onToolCall) {
        // Sin tool calls (o sin callback) — respuesta final
        fullText = iterText;
        break;
      }

      console.log(`[AI Runner] tool calls: ${toolCallParts.map(t => t.name).join(', ')}`);

      // Guardar turno del asistente (texto + tool calls)
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

      // Ejecutar cada tool y recopilar resultados
      const resultParts: vscode.LanguageModelToolResultPart[] = [];
      for (const tc of toolCallParts) {
        const result = await onToolCall(tc.callId, tc.name, tc.input as object);
        console.log(`[AI Runner] tool result callId=${tc.callId}: ${result.slice(0, 80)}`);
        resultParts.push(
          new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(result)])
        );
      }

      // Agregar resultados como mensaje de usuario para continuar el loop
      messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }
  } finally {
    activeCts.delete(cts);
    cts.dispose();
  }

  messages.push(vscode.LanguageModelChatMessage.Assistant(fullText));
  history.set(key, messages);

  console.log(`[AI Runner] ${model.vendor}/${model.family} v${model.version} | maxTokens:${model.maxInputTokens} | conv:${key} | msgs:${messages.length}`);

  return fullText;
}

// Descarta mensajes del inicio del historial hasta que los tokens entren en el límite.
// Siempre conserva el último mensaje del usuario (messages[length-1]).
async function truncateHistoryByTokens(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  maxTokens: number
): Promise<void> {
  const getText = (m: vscode.LanguageModelChatMessage): string => {
    return m.content
      .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
      .map(p => p.value)
      .join('');
  };

  while (messages.length > 1) {
    const fullText = messages.map(getText).join('\n');
    const tokenCount = await model.countTokens(fullText);
    if (tokenCount <= maxTokens) { break; }
    messages.splice(0, 1); // eliminar el mensaje más antiguo
  }
}

export function clearConversation(conversationId: string) {
  history.delete(conversationId);
}

export function clearAllConversations() {
  history.clear();
}
