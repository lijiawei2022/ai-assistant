import * as vscode from 'vscode';
import { AiAssistantViewProvider } from './aiAssistantViewProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('[AI Assistant] 插件已激活');

    // Register the helloWorld command
    let helloWorld = vscode.commands.registerCommand('ai-assitant.helloWorld', () => {
        vscode.window.showInformationMessage('Hello from AI Assistant!');
    });

    // Register the showPanel command
    let showPanel = vscode.commands.registerCommand('ai-assitant.showPanel', () => {
        AiAssistantViewProvider.createOrShow(context.extensionUri);
    });

    // Register command: Analyze selected code
    let analyzeCode = vscode.commands.registerCommand('ai-assitant.analyzeCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        if (!selectedText) {
            vscode.window.showInformationMessage('No code selected. Please select some code first.');
            return;
        }

        const fileName = editor.document.fileName.split(/[\\/]/).pop();
        const language = editor.document.languageId;

        AiAssistantViewProvider.createOrShow(context.extensionUri);
        
        setTimeout(() => {
            AiAssistantViewProvider.sendSelectedCode(
                selectedText, 
                fileName || 'unknown', 
                language
            );
        }, 500);
    });

    // Register command: Syntax check
    let syntaxCheck = vscode.commands.registerCommand('ai-assitant.syntaxCheck', () => {
        AiAssistantViewProvider.createOrShow(context.extensionUri);
        setTimeout(() => {
            AiAssistantViewProvider.triggerFeature('syntaxCheck');
        }, 300);
    });

    // Register command: Learning path
    let learningPath = vscode.commands.registerCommand('ai-assitant.learningPath', () => {
        AiAssistantViewProvider.createOrShow(context.extensionUri);
        setTimeout(() => {
            AiAssistantViewProvider.triggerFeature('learningPath');
        }, 300);
    });

    // Register the webview view provider
    const provider = new AiAssistantViewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AiAssistantViewProvider.viewType, provider),
        provider
    );

    context.subscriptions.push(helloWorld, showPanel, analyzeCode, syntaxCheck, learningPath);
}

export function deactivate(): Promise<void> | undefined {
    AiAssistantViewProvider.stopModelServer();
    return AiAssistantViewProvider.savePersistedData();
}