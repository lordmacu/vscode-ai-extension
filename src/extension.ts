import * as vscode from 'vscode';
import { AiRunnerProvider } from './webviewProvider';

let provider: AiRunnerProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    provider = new AiRunnerProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            AiRunnerProvider.viewType,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),
        vscode.commands.registerCommand('aiRunner.start', () => provider?.startPoller()),
        vscode.commands.registerCommand('aiRunner.stop',  () => provider?.stopPoller()),
        { dispose: () => provider?.disposePoller() }
    );
}

export function deactivate() {
    provider?.disposePoller();
}
