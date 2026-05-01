import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as nodejieba from 'nodejieba';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

// 配置
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';
const LLM_MODEL = 'qwen2.5-coder:3b';
const EMBED_MODEL = 'nomic-embed-text';
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;  // 递归分块重叠大小
const CACHE_DIR_NAME = 'documents_xiangliang';
const EMBEDDINGS_CACHE_FILE = 'embeddings.json';
// 检索参数配置
const VECTOR_THRESHOLD = 0.35;   // 向量检索预过滤阈值（余弦相似度，0.3-0.4较合理）
const BM25_MIN_SCORE = 0.1;      // BM25最小分数阈值（过滤明显不相关的）
const RRF_K = 60;                // RRF公式中的k值（标准值为60）
const TOP_K = 10;                // 最终返回的文档块数量

// BM25参数
const BM25_K1 = 1.5;              // 词频饱和参数（标准值1.2-2.0）
const BM25_B = 0.75;              // 文档长度归一化参数（标准值0.75）

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

interface RetrievalResult {
    fileName: string;
    content: string;
    vectorScore?: number;
    keywordScore?: number;
    rrfScore: number;
    rankVector?: number;
    rankKeyword?: number;
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

    // 获取缓存目录路径
    private getCacheDir(): string {
        const cacheDir = path.join(this._context.extensionPath, CACHE_DIR_NAME);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        return cacheDir;
    }

    // 计算单个文件的哈希（基于大小和修改时间）
    private getFileHash(filePath: string): string {
        const crypto = require('crypto');
        const stats = fs.statSync(filePath);
        const hash = crypto.createHash('md5');
        hash.update(`${path.basename(filePath)}_${stats.size}_${stats.mtimeMs}`);
        return hash.digest('hex');
    }

    // 加载文档并生成向量（支持增量缓存）
    private async loadDocumentsWithEmbeddings(): Promise<void> {
        if (docsLoaded) {
            return;
        }

        try {
            const documentsPath = path.join(this._context.extensionPath, 'documents');
            console.log(`RAG: Documents path: ${documentsPath}`);

            if (!fs.existsSync(documentsPath)) {
                console.log(`RAG: Documents folder not found: ${documentsPath}`);
                docsLoaded = true;
                return;
            }

            const cacheDir = this.getCacheDir();
            const files = fs.readdirSync(documentsPath).filter(f => {
                const ext = path.extname(f).toLowerCase();
                return ext === '.txt' || ext === '.md';
            });

            let totalChunks = 0;
            const newDocChunks: DocChunk[] = [];

            for (const file of files) {
                const filePath = path.join(documentsPath, file);
                const fileHash = this.getFileHash(filePath);
                const cacheFile = path.join(cacheDir, `${file}.json`);

                // 尝试从缓存加载该文件
                if (fs.existsSync(cacheFile)) {
                    try {
                        const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
                        if (cacheData.hash === fileHash && Array.isArray(cacheData.chunks)) {
                            newDocChunks.push(...cacheData.chunks);
                            totalChunks += cacheData.chunks.length;
                            console.log(`RAG: Loaded ${file} from cache (${cacheData.chunks.length} chunks)`);
                            continue;
                        }
                    } catch (e) {
                        console.log(`RAG: Cache read failed for ${file}, regenerating...`);
                    }
                }

                // 缓存不存在或无效，生成向量
                const content = fs.readFileSync(filePath, 'utf-8');
                console.log(`RAG: Processing file: ${file}, content length: ${content.length}`);

                const splitter = new RecursiveCharacterTextSplitter({
                    chunkSize: CHUNK_SIZE,
                    chunkOverlap: CHUNK_OVERLAP,
                });
                const chunks = await splitter.splitText(content);
                console.log(`RAG: File ${file} split into ${chunks.length} chunks`);

                const fileChunks: DocChunk[] = [];
                for (const chunkContent of chunks) {
                    const embedding = await this.generateEmbedding(chunkContent);
                    if (embedding.length > 0) {
                        const docChunk = { fileName: file, content: chunkContent, embedding };
                        fileChunks.push(docChunk);
                        newDocChunks.push(docChunk);
                        totalChunks++;
                    } else {
                        console.log(`RAG: Failed to generate embedding for chunk (length: ${chunkContent.length})`);
                    }
                }

                // 保存该文件的缓存
                try {
                    const cacheData = {
                        hash: fileHash,
                        chunks: fileChunks,
                        timestamp: Date.now()
                    };
                    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
                    console.log(`RAG: Saved ${file} to cache`);
                } catch (e) {
                    console.log(`RAG: Failed to save cache for ${file}`);
                }
            }

            // 清理已删除文件的缓存
            const cacheFiles = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
            for (const cacheFile of cacheFiles) {
                const fileName = cacheFile.replace('.json', '');
                if (!files.includes(fileName)) {
                    fs.unlinkSync(path.join(cacheDir, cacheFile));
                    console.log(`RAG: Removed cache for deleted file: ${fileName}`);
                }
            }

            docChunks = newDocChunks;
            this.buildBM25Index();
            docsLoaded = true;
            console.log(`RAG: Loaded ${totalChunks} document chunks from ${files.length} files (with incremental cache)`);
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
    private async retrieveRelevantDocs(question: string): Promise<{
        contextText: string;
        fileNames: string[];
        retrievalDetails: RetrievalResult[];
    }> {
        // 强制等待文档加载完成
        if (!docsLoaded) {
            console.log('RAG: Waiting for documents to load...');
            await this.loadDocumentsWithEmbeddings();
            console.log(`RAG: After load attempt, docsLoaded=${docsLoaded}, chunks=${docChunks.length}`);
        }

        if (docChunks.length === 0) {
            console.log('RAG: No document chunks available');
            return { contextText: '', fileNames: [], retrievalDetails: [] };
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

        // 计算关键词检索排名（使用BM25算法）
        const keywordCandidates = docChunks.map((chunk, index) => {
            const score = this.calculateBM25Score(keywords, index);
            return { chunk, score };
        }).filter(item => item.score >= BM25_MIN_SCORE); // 候选集B（BM25分数≥阈值）

        const keywordSorted = keywordCandidates.sort((a, b) => b.score - a.score);
        const keywordRankMap = new Map<DocChunk, number>();
        keywordSorted.forEach((item, index) => {
            keywordRankMap.set(item.chunk, index + 1);
        });
        console.log(`RAG: Keyword candidates (BM25>0): ${keywordCandidates.length}`);

        // 取A∪B，计算RRF分数
        const candidateChunks = new Set<DocChunk>();
        vectorRankMap.forEach((rank, chunk) => candidateChunks.add(chunk));
        keywordRankMap.forEach((rank, chunk) => candidateChunks.add(chunk));
        console.log(`RAG: Union candidates (A∪B): ${candidateChunks.size}`);

        const results = Array.from(candidateChunks).map(chunk => {
            const rankVector = vectorRankMap.get(chunk) || Number.MAX_SAFE_INTEGER;
            const rankKeyword = keywordRankMap.get(chunk) || Number.MAX_SAFE_INTEGER;

            const rrfVector = rankVector !== Number.MAX_SAFE_INTEGER ? 1 / (RRF_K + rankVector) : 0;
            const rrfKeyword = rankKeyword !== Number.MAX_SAFE_INTEGER ? 1 / (RRF_K + rankKeyword) : 0;
            const rrfScore = rrfVector + rrfKeyword;

            return { chunk, rrfScore, rankVector, rankKeyword, rrfVector, rrfKeyword };
        });

        // 输出RRF分数用于调试
        results.forEach(r => {
            console.log(`RAG: RRF=${r.rrfScore.toFixed(6)} (VectorRank=${r.rankVector}, KeywordRank=${r.rankKeyword}) with ${r.chunk.fileName}`);
        });

        // 按RRF分数排序，取Top K
        const topResults = results
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .slice(0, TOP_K);

        if (topResults.length === 0) {
            return { contextText: '', fileNames: [], retrievalDetails: [] };
        }

        const fileNames = [...new Set(topResults.map(r => r.chunk.fileName))];
        let contextText = '以下是知识库中相关的内容，请根据这些内容回答问题。\n\n知识库内容：\n';
        const retrievalDetails: RetrievalResult[] = [];
        
        for (const result of topResults) {
            contextText += `\n【文件: ${result.chunk.fileName}】\n\`\`\`\n${result.chunk.content}\n\`\`\`\n---\n`;
            retrievalDetails.push({
                fileName: result.chunk.fileName,
                content: result.chunk.content,
                vectorScore: result.rankVector !== Number.MAX_SAFE_INTEGER ? 
                    (vectorRankMap.get(result.chunk) ? 
                        this.cosineSimilarity(questionEmbedding, result.chunk.embedding) : 0) : undefined,
                keywordScore: result.rankKeyword !== Number.MAX_SAFE_INTEGER ? 
                    keywordRankMap.get(result.chunk) || undefined : undefined,
                rrfScore: result.rrfScore,
                rankVector: result.rankVector !== Number.MAX_SAFE_INTEGER ? result.rankVector : undefined,
                rankKeyword: result.rankKeyword !== Number.MAX_SAFE_INTEGER ? result.rankKeyword : undefined
            });
        }

        console.log(`RAG: Found relevant docs: ${fileNames.join(", ")}`);
        return { contextText, fileNames, retrievalDetails };
    }

    // 停用词集合
    private stopWords: Set<string> | null = null;

    // BM25相关字段
    private bm25Ready: boolean = false;
    private docTermFreqs: Map<string, number>[] = [];  // 每篇文档的词频映射
    private docFreqs: Map<string, number> = new Map(); // 词在多少篇文档中出现
    private avgdl: number = 0;
    private totalDocs: number = 0;

    // 加载停用词
    private loadStopWords(): Set<string> {
        if (this.stopWords !== null) {
            return this.stopWords;
        }

        this.stopWords = new Set<string>();
        try {
            const stopWordsPath = path.join(this._context.extensionPath, 'stopwords.txt');
            if (fs.existsSync(stopWordsPath)) {
                const content = fs.readFileSync(stopWordsPath, 'utf-8');
                const lines = content.split('\n');
                for (const line of lines) {
                    const word = line.trim();
                    if (word && !word.startsWith('#')) {
                        this.stopWords.add(word.toLowerCase());
                    }
                }
                console.log(`RAG: Loaded ${this.stopWords.size} stop words`);
            }
        } catch (e) {
            console.log('RAG: Failed to load stop words, using empty set');
        }
        return this.stopWords;
    }

    // 构建BM25索引
    private buildBM25Index(): void {
        if (docChunks.length === 0) {
            return;
        }

        const stopWords = this.loadStopWords();
        this.docTermFreqs = [];
        this.docFreqs.clear();
        let totalLength = 0;

        // 对每个文档分词并统计词频
        for (const chunk of docChunks) {
            let words: string[] = [];
            try {
                words = nodejieba.cut(chunk.content, true)
                    .map(w => w.trim().toLowerCase())
                    .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !stopWords.has(w));
            } catch (e) {
                words = chunk.content.split(/[\s\.,;:!?，。；：！？]+/)
                    .map(w => w.toLowerCase())
                    .filter(w => w.length >= 2 && !stopWords.has(w));
            }

            // 计算该文档的词频
            const termFreq = new Map<string, number>();
            for (const word of words) {
                termFreq.set(word, (termFreq.get(word) || 0) + 1);
            }
            this.docTermFreqs.push(termFreq);

            // 统计文档频率（词出现在多少篇文档中）
            const uniqueWords = new Set(words);
            for (const word of uniqueWords) {
                this.docFreqs.set(word, (this.docFreqs.get(word) || 0) + 1);
            }

            totalLength += words.length;
        }

        this.totalDocs = docChunks.length;
        this.avgdl = totalLength / this.totalDocs;
        this.bm25Ready = true;
        console.log(`RAG: BM25 index built with ${this.totalDocs} docs, avgdl=${this.avgdl.toFixed(2)}`);
    }

    // 计算标准BM25分数
    private calculateBM25Score(queryKeywords: string[], docIndex: number): number {
        if (!this.bm25Ready || docIndex >= docChunks.length) {
            return 0;
        }

        const termFreq = this.docTermFreqs[docIndex];
        if (!termFreq) return 0;

        // 计算文档长度（词数）
        let dl = 0;
        for (const count of termFreq.values()) {
            dl += count;
        }

        let score = 0;

        for (const queryWord of queryKeywords) {
            const tf = termFreq.get(queryWord) || 0;
            if (tf === 0) continue;

            const df = this.docFreqs.get(queryWord) || 0;
            if (df === 0) continue;

            // 标准BM25 IDF: log((N - df + 0.5) / (df + 0.5))
            const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5));

            // BM25公式: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)))
            const numerator = tf * (BM25_K1 + 1);
            const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgdl));
            score += idf * (numerator / denominator);
        }

        return score;
    }

    // 提取关键词（使用jieba分词+停用词过滤）
    private extractKeywords(text: string): string[] {
        const keywords: Set<string> = new Set();
        const stopWords = this.loadStopWords();

        // 使用jieba分词处理中文
        try {
            const jiebaWords = nodejieba.cut(text, true); // 精确模式
            for (const word of jiebaWords) {
                const w = word.trim().toLowerCase();
                if (w.length >= 2 && !stopWords.has(w) && !/^\d+$/.test(w)) {
                    keywords.add(w);
                }
            }
        } catch (e) {
            console.log('RAG: jieba cut failed, fallback to simple extraction');
            // 降级方案：简单提取中文词组
            const chineseSegments = text.match(/[\u4e00-\u9fa5]+/g) || [];
            for (const segment of chineseSegments) {
                if (segment.length >= 2 && !stopWords.has(segment.toLowerCase())) {
                    keywords.add(segment.toLowerCase());
                }
            }
        }

        // 提取英文单词（长度>=2，过滤停用词）
        const englishWords = text.toLowerCase().match(/[a-z]{2,}/g) || [];
        for (const word of englishWords) {
            if (!stopWords.has(word)) {
                keywords.add(word);
            }
        }

        return [...keywords];
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

            // 发送最终回答给前端（包含检索详情）
            if (AiAssistantViewProvider.currentPanel) {
                AiAssistantViewProvider.currentPanel.webview.postMessage({
                    type: 'aiResponse',
                    response: finalAnswer,
                    hasContext: hasContext,
                    retrievalDetails: ragResult.retrievalDetails || []
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