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
// RRF标准实现无需阈值，仅按融合分数排序取Top N
const VECTOR_THRESHOLD = 0.6;    // 向量检索预过滤阈值（按最初要求）
const KEYWORD_MIN_MATCH = 1;       // 关键词检索最小匹配数（避免单关键词误匹配）
const POST_RRF_THRESHOLD = 0.025;  // RRF后置截断阈值（保留弱相关匹配）

// 系统设计提示词：面向程序设计领域的AI助教
const SYSTEM_PROMPT = `你是程序设计领域的AI助教，专注于帮助学生掌握编程知识和技能。

## 角色定位
- 资深程序员与计算机科学导师
- 熟悉C语言等主流编程语言
- 精通数据结构、算法、软件工程等核心知识

## 核心能力
1. **代码分析**：审查代码语法、逻辑、性能问题
2. **错误诊断**：定位并解释编译错误、运行时错误、逻辑错误
3. **概念讲解**：清晰解释语法特性、算法原理、设计模式
4. **调试指导**：提供调试思路、工具和技巧
5. **最佳实践**：推荐代码规范、优化方案和工程经验

## 回答原则
- **简洁精准**：直接回答核心问题，避免冗余解释
- **知识库优先**：优先依据知识库内容作答，知识库不足时基于专业知识回答
- **因材施教**：根据问题难度调整讲解深度，新手侧重基础，进阶者侧重原理
- **代码示例**：必要时提供完整可运行的代码示例（用代码块包裹）
- **中文为主**：使用简洁中文，专业术语保留英文原文

## 交互方式
- 理解用户意图：区分代码审查、概念咨询、错误排查等场景
- 灵活处理输入：支持代码片段、完整程序、错误信息、概念问题等多种格式
- 保持上下文：在多轮对话中记住之前的讨论内容`;

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

    // 对话历史，初始带系统提示词
    private conversationHistory: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string
    }> = [
        { role: 'system', content: SYSTEM_PROMPT }
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

    // 调用 Ollama 多轮对话接口（自动注入系统提示到最前）
    private callOllama(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
        // 移除历史中可能存在的旧系统消息，插入最新的系统提示到最前
        const messagesWithoutSystem = messages.filter(m => m.role !== 'system');
        const finalMessages = [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...messagesWithoutSystem];

        return new Promise((resolve) => {
            try {
                const body = JSON.stringify({
                    model: LLM_MODEL,
                    messages: finalMessages,
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

        // 计算向量检索排名（预过滤 similarity ≥ 0.45）
        const vectorCandidates = docChunks.map(chunk => {
            const score = (useVector && chunk.embedding.length > 0) 
                ? this.cosineSimilarity(questionEmbedding, chunk.embedding) : 0;
            return { chunk, score };
        }).filter(item => item.score >= VECTOR_THRESHOLD); // 候选集A

        const vectorSorted = vectorCandidates.sort((a, b) => b.score - a.score);
        const vectorRankMap = new Map<DocChunk, number>();
        vectorSorted.forEach((item, index) => {
            vectorRankMap.set(item.chunk, index + 1); // 仅对候选集A排名
        });
        console.log(`RAG: Vector candidates (≥${VECTOR_THRESHOLD}): ${vectorCandidates.length}`);

        // 计算关键词检索排名（预过滤 matchCount ≥ 1）
        const keywordCandidates = docChunks.map(chunk => {
            let keywordCount = 0;
            const chunkLower = chunk.content.toLowerCase();
            for (const kw of keywords) {
                if (chunkLower.includes(kw.toLowerCase())) {
                    keywordCount += 1;
                }
            }
            return { chunk, score: keywordCount };
        }).filter(item => item.score >= KEYWORD_MIN_MATCH); // 候选集B

        const keywordSorted = keywordCandidates.sort((a, b) => b.score - a.score);
        const keywordRankMap = new Map<DocChunk, number>();
        keywordSorted.forEach((item, index) => {
            keywordRankMap.set(item.chunk, index + 1); // 仅对候选集B排名
        });
        console.log(`RAG: Keyword candidates (≥${KEYWORD_MIN_MATCH} matches): ${keywordCandidates.length}`);

        // 取A∪B，计算RRF分数
        const candidateChunks = new Set<DocChunk>();
        vectorRankMap.forEach((rank, chunk) => candidateChunks.add(chunk));
        keywordRankMap.forEach((rank, chunk) => candidateChunks.add(chunk));
        console.log(`RAG: Union candidates (A∪B): ${candidateChunks.size}`);

        const k = 60;
        const results = Array.from(candidateChunks).map(chunk => {
            const rankVector = vectorRankMap.get(chunk) || Number.MAX_SAFE_INTEGER;
            const rankKeyword = keywordRankMap.get(chunk) || Number.MAX_SAFE_INTEGER;
            
            const rrfVector = rankVector !== Number.MAX_SAFE_INTEGER ? 1 / (k + rankVector) : 0;
            const rrfKeyword = rankKeyword !== Number.MAX_SAFE_INTEGER ? 1 / (k + rankKeyword) : 0;
            const rrfScore = rrfVector + rrfKeyword;
            
            return { chunk, rrfScore, rankVector, rankKeyword, rrfVector, rrfKeyword };
        });

        // 输出RRF分数用于调试
        results.forEach(r => {
            console.log(`RAG: RRF=${r.rrfScore.toFixed(6)} (VectorRank=${r.rankVector}, KeywordRank=${r.rankKeyword}) with ${r.chunk.fileName}`);
        });

        // 后置截断：RRF ≥ 0.015，排序取Top10
        const topResults = results
            .filter(r => r.rrfScore >= POST_RRF_THRESHOLD)
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .slice(0, 10);

        if (topResults.length === 0) {
            return { contextText: '', fileNames: [] };
        }

        const fileNames = [...new Set(topResults.map(r => r.chunk.fileName))];
        let contextText = '以下是知识库中相关的内容，请根据这些内容回答问题。\n\n知识库内容：\n';
        for (const result of topResults) {
            contextText += `\n【文件: ${result.chunk.fileName}】\n\`\`\`\n${result.chunk.content}\n\`\`\`\n---\n`;
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
        
        // 提取中文：所有2字以上连续子串（解决长句无法拆分问题）
        const chineseSegments = lowerText.match(/[\u4e00-\u9fa5]+/g) || [];
        for (const segment of chineseSegments) {
            // 生成所有可能的2字以上子串
            for (let i = 0; i < segment.length; i++) {
                for (let j = i + 1; j < segment.length; j++) {
                    const substr = segment.substring(i, j + 1);
                    if (substr.length >= 2) {
                        keywords.push(substr);
                    } else {
                        break;
                    }
                }
            }
        }
        
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
            const hasRagDocs = ragResult.fileNames.length > 0;
            console.log(`RAG: hasRagDocs=${hasRagDocs}, files=${ragResult.fileNames.join(",")}`);
            
            // 构造用户消息内容（系统提示已在callOllama中注入，无需重复）
            let userContent = '';

            if (hasRagDocs) {
                // 有知识库文档：根据文档+问题+对话历史回答
                userContent = `${ragResult.contextText}\n用户问题：${question}`;
            } else {
                // 无知识库文档：直接根据问题+对话历史回答
                userContent = `用户问题：${question}`;
            }
            
            // 如果有选中代码，始终拼接（不再限制格式和关键词）
            if (hasContext && AiAssistantViewProvider.selectedCodeContext) {
                const ctx = AiAssistantViewProvider.selectedCodeContext;
                userContent += `\n\n附：相关代码\n文件: ${ctx.fileName}\n语言: ${ctx.language}\n\`\`\`${ctx.language}\n${ctx.code}\n\`\`\``;
                // 拼接后清空，避免下次问题继续携带
                AiAssistantViewProvider.selectedCodeContext = null;
            }

            // 用户消息加入历史
            this.conversationHistory.push({ role: 'user', content: userContent });

            // 传入完整历史调用大模型
            const rawAnswer = await this.callOllama(this.conversationHistory);

            // 先把大模型原始回答存入历史（不含手动拼接的来源说明，避免历史污染）
            this.conversationHistory.push({ role: 'assistant', content: rawAnswer });

            // 拼接来源说明，仅用于前端展示，不进历史
            let finalAnswer = rawAnswer;
            if (hasRagDocs) {
                finalAnswer += `\n\n知识库中有相关文档：${ragResult.fileNames.join(", ")}，本地大模型根据相关文档回答`;
            } else {
                finalAnswer += `\n\n知识库中无相关文档，本地大模型直接回答`;
            }

            // 发送最终回答给前端
            if (AiAssistantViewProvider.currentPanel) {
                AiAssistantViewProvider.currentPanel.webview.postMessage({
                    type: 'aiResponse',
                    response: finalAnswer,
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
        this.conversationHistory = [ // 重置为系统提示词
            { role: 'system', content: SYSTEM_PROMPT }
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