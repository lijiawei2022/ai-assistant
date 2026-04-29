import * as vscode from 'vscode';
import * as cp from 'child_process';

// 配置
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const LLM_MODEL = 'qwen2.5-coder:3b';

export class AiAssistantViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiAssistantView';
    private static currentPanel: vscode.WebviewView | undefined;
    private static selectedCodeContext: { code: string; fileName: string; language: string } | null = null;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    
constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this._extensionUri = extensionUri;
    this._context = context;
}

// 对话历史，初始带系统提示
private conversationHistory: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string
}> = [
    { role: 'system', content: '你是一个专业的编程助手，请用中文简洁回答用户的问题。' }
];

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        AiAssistantViewProvider.currentPanel = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        if (AiAssistantViewProvider.selectedCodeContext) {
            const ctx = AiAssistantViewProvider.selectedCodeContext;
            setTimeout(() => {
                webviewView.webview.postMessage({
                    type: 'selectedCode',
                    code: ctx.code,
                    fileName: ctx.fileName,
                    language: ctx.language
                });
                AiAssistantViewProvider.selectedCodeContext = null;
            }, 100);
        }

        webviewView.webview.onDidReceiveMessage(
            (message) => {
                switch (message.type) {
                    case 'askQuestion':
                        this.handleAskQuestion(message.question, message.hasContext);
                        break;
                    case 'clearChat':
                        this.handleClearChat();
                        break;
                }
            },
            undefined,
            this._context.subscriptions
        );
    }

    // 调用 Ollama 多轮对话接口
    private callOllama(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
        return new Promise((resolve) => {
            try {
                const body = JSON.stringify({
                    model: LLM_MODEL,
                    messages: messages,
                    stream: false
                });
                
                cp.execFile('curl', [
                    '-s', '-X', 'POST',
                    OLLAMA_URL,
                    '-H', 'Content-Type: application/json',
                    '-d', body
                ], { timeout: 120000 }, (error, stdout) => {
                    if (error) {
                        resolve('调用大模型失败: ' + error.message);
                        return;
                    }
                    try {
                        const data = JSON.parse(stdout);
                        resolve(data.message?.content || '未收到有效响应');
                    } catch (e) {
                        resolve('解析响应失败: ' + stdout.substring(0, 100));
                    }
                });
            } catch (e) {
                resolve('生成失败');
            }
        });
    }

    private async handleAskQuestion(question: string, hasContext: boolean = false) {
        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.webview.postMessage({
                type: 'loading',
                isLoading: true
            });
        }

        try {
            // 构造用户消息内容
            let userContent = question;
            
            // 拼接选中的代码上下文（如果有）
            if (hasContext && AiAssistantViewProvider.selectedCodeContext) {
                const ctx = AiAssistantViewProvider.selectedCodeContext;
                userContent += `\n\n参考代码：\n文件: ${ctx.fileName}\n语言: ${ctx.language}\n\`\`\`\n${ctx.code}\n\`\`\``;
            }

            // 用户消息加入历史
            this.conversationHistory.push({ role: 'user', content: userContent });

            // 传入完整历史调用大模型
            let answer = await this.callOllama(this.conversationHistory);

            // 大模型回复加入历史
            this.conversationHistory.push({ role: 'assistant', content: answer });

            if (AiAssistantViewProvider.currentPanel) {
                AiAssistantViewProvider.currentPanel.webview.postMessage({
                    type: 'aiResponse',
                    response: answer,
                    hasContext: hasContext
                });
            }

        } catch (error) {
            let errorMessage = '发生未知错误';
            if (error instanceof Error) {
                errorMessage = '错误: ' + error.message;
            }

            if (AiAssistantViewProvider.currentPanel) {
                AiAssistantViewProvider.currentPanel.webview.postMessage({
                    type: 'aiResponse',
                    response: errorMessage,
                    hasContext: hasContext,
                    isError: true
                });
            }
        } finally {
            if (AiAssistantViewProvider.currentPanel) {
                AiAssistantViewProvider.currentPanel.webview.postMessage({
                    type: 'loading',
                    isLoading: false
                });
            }
        }
    }

    private handleClearChat() {
        AiAssistantViewProvider.selectedCodeContext = null;
        this.conversationHistory = [ // 重置为仅系统提示
            { role: 'system', content: '你是一个专业的编程助手，请用中文简洁回答用户的问题。' }
        ];
        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.webview.postMessage({
                type: 'clearChat'
            });
        }
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.show();
            return;
        }
        vscode.commands.executeCommand('aiAssistantView.focus');
    }

    public static sendSelectedCode(code: string, fileName: string, language: string) {
        AiAssistantViewProvider.selectedCodeContext = { code, fileName, language };
        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.webview.postMessage({
                type: 'selectedCode',
                code: code,
                fileName: fileName,
                language: language
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')
        );
        const styleResetUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css')
        );
        const styleVSCodeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css')
        );
        const styleMainUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css')
        );

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleResetUri}" rel="stylesheet">
                <link href="${styleVSCodeUri}" rel="stylesheet">
                <link href="${styleMainUri}" rel="stylesheet">
                <title>AI Assistant</title>
            </head>
            <body>
                <div class="container">
                    <header>
                        <h1>AI Assistant</h1>
                        <p>基于本地大模型的AI编程助手</p>
                    </header>
                    
                    <div id="code-context" class="code-context" style="display: none;">
                        <div class="code-context-header">
                            <span id="context-label">Selected Code</span>
                            <button id="clear-context" class="clear-context-btn">×</button>
                        </div>
                        <pre id="selected-code"></pre>
                        <div id="context-info"></div>
                    </div>
                    
                    <div id="chat-container" class="chat-container">
                        <div id="chat-messages" class="chat-messages"></div>
                    </div>
                    
                    <div class="input-container">
                        <textarea id="question-input" placeholder="Ask about the selected code or type any question..." rows="3"></textarea>
                        <div class="button-container">
                            <button id="ask-button" class="primary-button">Ask AI</button>
                            <button id="clear-button" class="secondary-button">Clear</button>
                        </div>
                    </div>
                    
                    <div class="status-bar">
                        <span id="status">Ready</span>
                    </div>
                </div>
                
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}