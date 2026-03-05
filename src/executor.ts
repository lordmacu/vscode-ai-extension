import * as vscode from 'vscode';

// Historial de conversaciones: conversationId → mensajes acumulados
const history = new Map<string, vscode.LanguageModelChatMessage[]>();

export interface ExecuteOptions {
  modelFamily?: string;
  justification?: string;
  modelOptions?: Record<string, any>;
  systemPrompt?: string;
  maxInputTokens?: number; // truncar historial si supera este límite
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

  messages.push(vscode.LanguageModelChatMessage.User(prompt));

  // Truncar historial si supera el límite de tokens
  if (maxInputTokens && messages.length > 2) {
    await truncateHistoryByTokens(model, messages, maxInputTokens);
  }

  const cts = new vscode.CancellationTokenSource();

  const requestOptions: vscode.LanguageModelChatRequestOptions = {};
  if (justification)              { requestOptions.justification = justification; }
  if (Object.keys(modelOptions).length) { requestOptions.modelOptions  = modelOptions; }

  const response = await model.sendRequest(messages, requestOptions, cts.token);

  let fullText = '';
  for await (const chunk of response.text) {
    fullText += chunk;
  }
  cts.dispose();

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
