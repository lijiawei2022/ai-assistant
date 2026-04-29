import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// 配置
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';
const LLM_MODEL = 'qwen2.5-coder:3b';
const EMBED_MODEL = 'nomic-embed-text';
const CHUNK_SIZE = 500;
const SIMILARITY_THRESHOLD = 0.6;

interface DocChunk {
    fileName: string;
    content: string;
    embedding: number[];
}

let docChunks: DocChunk[] = [];
let docsLoaded = false;

export class AiAssistantViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiAssistantView';
    private static currentPanel: vscode.WebviewView | undefined;
    private static selectedCodeContext: { code: string; fileName: string; language: string } | null = null;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    
    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        // 初始化时加载文档（异步）
        this.loadDocumentsWithEmbeddings();
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

    // 加载文档并生成向量
    private async loadDocumentsWithEmbeddings(): Promise<void> {
        if (docsLoaded) {
            return;
        }

        try {
            // 优先用工作区根目录，没有的话用扩展所在目录（确保能找到documents文件夹）
            const workspaceRoot = vscode.workspace.rootPath || this._context.extensionPath;
            const documentsPath = path.join(workspaceRoot, 'documents');
            console.log(`RAG: Documents path: ${documentsPath}`);

            if (!fs.existsSync(documentsPath)) {
                console.log(`RAG: Documents folder not found: ${documentsPath}`);
                docsLoaded = true;
                return;
            }

            const files = fs.readdirSync(documentsPath);
            let totalChunks = 0;
            
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (ext !== '.txt' && ext !== '.md') {
                    continue;
                }

                const filePath = path.join(documentsPath, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                
                // 按行分块
                const lines = content.split('\n');
                let chunkContent = '';
                
                for (const line of lines) {
                    chunkContent += line + '\n';
                    if (chunkContent.length >= CHUNK_SIZE) {
                        // 为当前块生成向量
                        const embedding = await this.generateEmbedding(chunkContent);
                        if (embedding.length > 0) {
                            docChunks.push({ fileName: file, content: chunkContent, embedding });
                            totalChunks++;
                        }
                        chunkContent = '';
                    }
                }
                
                // 处理最后一块
                if (chunkContent.trim().length > 0) {
                    const embedding = await this.generateEmbedding(chunkContent);
                    if (embedding.length > 0) {
                        docChunks.push({ fileName: file, content: chunkContent, embedding });
                        totalChunks++;
                    }
                }
            }

            docsLoaded = true;
            console.log(`RAG: Loaded ${totalChunks} document chunks from ${files.length} files`);
        } catch (error) {
            console.error('RAG: Failed to load documents', error);
            docsLoaded = true;
        }
    }

    // 生成向量
    private generateEmbedding(text: string): Promise<number[]> {
        return new Promise((resolve) => {
            try {
                const body = JSON.stringify({
                    model: EMBED_MODEL,
                    prompt: text
                });
                
                cp.execFile('curl', [
                    '-s', '-X', 'POST',
                    OLLAMA_EMBED_URL,
                    '-H', 'Content-Type: application/json',
                    '-d', body
                ], { timeout: 30000 }, (error, stdout) => {
                    if (error) {
                        resolve([]);
                        return;
                    }
                    try {
                        const data = JSON.parse(stdout);
                        resolve(data.embedding || []);
                    } catch (e) {
                        resolve([]);
                    }
                });
            } catch (e) {
                resolve([]);
            }
        });
    }

    // 余弦相似度
    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length === 0 || b.length === 0 || a.length !== b.length) {
            return 0;
        }
        
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        return denominator === 0 ? 0 : dotProduct / denominator;
    }

    // 检索相关文档（混合检索：向量 + 关键词）
    private async retrieveRelevantDocs(question: string): Promise<{ contextText: string; fileNames: string[] }> {
        // 强制等待文档加载完成
        if (!docsLoaded) {
            console.log('RAG: Waiting for documents to load...');
            await this.loadDocumentsWithEmbeddings();
            console.log(`RAG: After load attempt, docsLoaded=${docsLoaded}, chunks=${docChunks.length}`);
        }

        if (docChunks.length === 0) {
            console.log('RAG: No document chunks available');
            return { contextText: '', fileNames: [] };
        }

        console.log(`RAG: Searching among ${docChunks.length} chunks for: ${question}`);

        // 提取问题关键词（中文词组 + 英文单词）
        const keywords = this.extractKeywords(question);
        console.log(`RAG: Keywords extracted: ${keywords.join(", ")}`);

        // 计算问题向量
        const questionEmbedding = await this.generateEmbedding(question);
        let useVector = questionEmbedding.length > 0;

        // 计算所有块的相似度（混合打分）
        const results = docChunks.map(chunk => {
            // 向量相似度
            let vectorScore = 0;
            if (useVector && chunk.embedding.length > 0) {
                vectorScore = this.cosineSimilarity(questionEmbedding, chunk.embedding);
            }

            // 关键词匹配得分
            let keywordScore = 0;
            const chunkLower = chunk.content.toLowerCase();
            for (const kw of keywords) {
                if (chunkLower.includes(kw.toLowerCase())) {
                    keywordScore += 1;
                }
            }
            // 归一化关键词得分
            keywordScore = keywords.length > 0 ? keywordScore / keywords.length : 0;

            // 混合得分：向量占40%，关键词占60%（关键词对中文更可靠）
            const hybridScore = vectorScore * 0.4 + keywordScore * 0.6;

            return { chunk, similarity: hybridScore, vectorScore, keywordScore };
        });

        // 输出相似度分数用于调试
        results.forEach(r => {
            console.log(`RAG: Hybrid=${r.similarity.toFixed(4)} (Vector=${r.vectorScore.toFixed(4)}, Keyword=${r.keywordScore.toFixed(4)}) with ${r.chunk.fileName}`);
        });

        // 按混合相似度过滤（阈值0.3）并排序取Top3
        const topResults = results
          .filter(r => r.similarity >= 0.3)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 3);

        if (topResults.length === 0) {
            return { contextText: '', fileNames: [] };
        }

        const fileNames = [...new Set(topResults.map(r => r.chunk.fileName))];
        let contextText = '以下是知识库中相关的内容，请根据这些内容回答问题。\n\n知识库内容：\n';
        for (const result of topResults) {
            contextText += `\n【文件: ${result.chunk.fileName}】\n${result.chunk.content}\n---\n`;
        }

        console.log(`RAG: Found relevant docs: ${fileNames.join(", ")}`);
        return { contextText, fileNames };
    }

    // 提取关键词（支持中英文）
    private extractKeywords(text: string): string[] {
        const lowerText = text.toLowerCase();
        const keywords: string[] = [];
        
        // 提取英文单词（长度>=2）
        const englishWords = lowerText.match(/[a-z]{2,}/g) || [];
        keywords.push(...englishWords);
        
        // 提取中文词组（长度>=2的连续汉字）
        const chineseWords = lowerText.match(/[\u4e00-\u9fa5]{2,}/g) || [];
        keywords.push(...chineseWords);
        
        // 去重
        return [...new Set(keywords)];
    }

    private async handleAskQuestion(question: string, hasContext: boolean = false) {
        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.webview.postMessage({
                type: 'loading',
                isLoading: true
            });
        }

        try {
            // 检索相关文档
            const ragResult = await this.retrieveRelevantDocs(question);
            const useRag = ragResult.fileNames.length > 0;
            
            // 构造用户消息内容
            let userContent = useRag 
                ? `${ragResult.contextText}\n\n问题：${question}\n\n请根据上面的知识库内容回答，如果知识库中没有相关内容，请直接回答。`
                : question;
            
            // 拼接选中的代码上下文（如果有）
            if (hasContext && AiAssistantViewProvider.selectedCodeContext) {
                const ctx = AiAssistantViewProvider.selectedCodeContext;
                userContent += `\n\n参考代码：\n文件: ${ctx.fileName}\n语言: ${ctx.language}\n\`\`\`\n${ctx.code}\n\`\`\``;
            }

            // 用户消息加入历史
            this.conversationHistory.push({ role: 'user', content: userContent });

            // 传入完整历史调用大模型
            let answer = await this.callOllama(this.conversationHistory);

            // 拼接来源说明
            if (useRag && ragResult.fileNames.length > 0) {
                answer += `\n\n根据知识库中的${ragResult.fileNames.join(", ")}生成`;
            } else {
                answer += `\n\n根据大模型回答`;
            }

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