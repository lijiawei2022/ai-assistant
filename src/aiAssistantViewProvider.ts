import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import * as nodejieba from 'nodejieba';
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import Graph from 'graphology';

// 配置
const LLM_URL = 'http://localhost:8000/api/chat';
const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';
const LLM_MODEL = 'huggingface-serve';
const EMBED_MODEL = 'bge-m3';
const RERANKER_MODEL = 'Xenova/bge-reranker-base';
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 200;
const CACHE_DIR_NAME = 'documents_xiangliang';
const EMBEDDINGS_CACHE_FILE = 'embeddings.json';
const RERANKER_CACHE_DIR = 'reranker_model';
// 检索参数配置
const VECTOR_THRESHOLD = 0.3;   // 向量检索预过滤阈值（余弦相似度，bge-m3分布较平，阈值可适当降低）
const BM25_MIN_SCORE = 0.1;      // BM25最小分数阈值（过滤明显不相关的）
const RRF_K = 60;                // RRF公式中的k值（标准值为60）
const RRF_TOP_K = 10;            // RRF选出候选数（交叉编码器rerank开销大，10个候选足够）
const RERANK_TOP_K = 5;          // rerank后最终返回数量
const RRF_VECTOR_WEIGHT = 0.7;   // 向量检索在RRF中的权重（KG扩展词已增强BM25，向量权重适当提高）
const RRF_KEYWORD_WEIGHT = 0.3;  // 关键词检索在RRF中的权重

// BM25参数
const BM25_K1 = 1.5;              // 词频饱和参数（标准值1.2-2.0）
const BM25_B = 0.75;              // 文档长度归一化参数（标准值0.75）

// 知识图谱参数
const KG_MAX_MATCHED_NODES = 5;   // 最大匹配节点数（防止上下文过长）
const KG_MAX_HOPS = 1;            // 图遍历最大跳数（1跳足够，2跳上下文膨胀严重）
const KG_MAX_EXPANDED_KW = 8;     // 最大扩展关键词数
const KG_MAX_CONTEXT_CHARS = 800;  // KG上下文最大字符数

function ollamaRequest(url: string, body: object, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const parsed = new URL(url);

        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            },
            timeout: timeoutMs
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
                }
            });
        });

        req.on('error', (err: Error) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

        req.write(bodyStr);
        req.end();
    });
}

// 系统设计提示词：面向程序设计领域的AI助教
const SYSTEM_PROMPT = `你是程序设计领域的AI助教，专注于帮助学生掌握编程知识和技能。熟悉C语言等主流编程语言，精通数据结构、算法、软件工程等核心知识。

## 输入格式
每条用户消息固定包含以下四部分（某部分为"空"表示未提供）：
- 用户问题：用户的核心诉求
- 用户提供的代码：用户选中的代码片段
- 知识图谱关联：从知识图谱检索的结构化关联信息（知识点层级、错误-原因-解决方案的因果链）
- 参考文档：从知识库检索的相关文档片段

## 回答要求
1. 优先依据知识图谱关联理解问题的上下文关系，再结合参考文档获取详细内容
2. 知识图谱关联不为空时，按图谱中的因果链和解决方案链组织回答结构
3. 参考文档不为空时，用文档内容充实回答的细节
4. 用户提供的代码不为空时，结合代码实际情况分析问题，将文档知识与代码对应
5. 简洁精准，直接回答核心问题
6. 必要时提供完整可运行的代码示例（用代码块包裹）
7. 使用简洁中文，专业术语保留英文原文`;

const SYNTAX_CHECK_PROMPT = `你是C语言代码审查专家。请对用户提供的代码进行全面检查。

## 检查维度
1. **语法错误**：编译器会报错的问题（缺少分号、括号不匹配、类型错误、缺少头文件等）
2. **潜在运行时错误**：可能导致崩溃的问题（空指针解引用、数组越界、内存泄漏、使用未初始化变量、悬垂指针等）
3. **逻辑错误**：代码能运行但结果可能不正确的问题（off-by-one、条件判断错误、类型转换问题等）
4. **代码规范与安全**：命名、格式、安全性等方面的改进建议（缓冲区溢出风险、不安全的函数调用等）

## 输出格式
对每个发现的问题，按以下格式输出：

### 问题N：[问题分类] 简短描述
- **位置**：相关代码片段
- **原因**：问题根因分析
- **修复**：修正后的代码

如果代码没有问题，输出：
**代码检查通过**
并给出进一步的改进建议。

## 注意
- 只报告确实存在的问题，不要过度警告
- 修复建议要给出完整可运行的代码
- 如果提供了编译器输出，优先解释编译器报告的错误
- 使用简洁中文，专业术语保留英文`;

const LEARNING_PATH_PROMPT = `你是C语言编程教学专家，负责为学生规划个性化学习路径。

## 任务
根据学生描述的学习需求和过往学习记录，评估其当前水平，识别知识薄弱点，并推荐个性化的学习路径。

## 输出格式

### 📊 当前水平评估
根据学生的描述和交互记录，评估编程水平（初学者/入门/进阶），并说明判断依据。

### 🔍 知识薄弱点
根据学生的描述，列出需要加强的知识领域，按优先级排列。

### 📚 推荐学习路径
按优先级排列的学习主题，每个主题包含：
1. **主题名称** - 为什么需要学这个
2. **核心知识点** - 需要掌握的关键概念
3. **练习建议** - 推荐的编程练习

### 🎯 下一步行动
学生现在最应该做什么（具体、可执行的建议）。

## 注意
- 回答要针对学生描述的具体需求，不要泛泛而谈
- 学习路径要有梯度，从易到难
- 结合学生的实际问题和代码来分析
- 如果参考文档中有相关内容，优先推荐
- 使用简洁中文，专业术语保留英文`;

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

interface KGNodeData {
    id: string;
    type: 'knowledge' | 'error' | 'solution' | 'symptom' | 'tool';
    name: string;
    aliases: string[];
    description: string;
    level?: string;
}

interface KGEdgeData {
    relation: string;
    weight?: number;
}

interface KGContextResult {
    contextText: string;
    matchedNodes: string[];
    expandedKeywords: string[];
}

let docChunks: DocChunk[] = [];
let docsLoaded = false;
let modelConnected = false;
let initCompleted = false;
let rerankerReady = false;
let rerankerModel: any = null;
let rerankerTokenizer: any = null;
let modelServerProcess: ChildProcess | null = null;

let kgGraph: Graph | null = null;
let kgNodesMap: Map<string, KGNodeData> = new Map();
let kgNameIndex: Map<string, string[]> = new Map();
let kgLoaded = false;

const LLM_PORT = 8000;
const LLM_STARTUP_TIMEOUT = 120;
const LLM_POLL_INTERVAL = 3000;

export class AiAssistantViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'aiAssistantView';
    private static currentPanel: vscode.WebviewView | undefined;
    private static selectedCodeContext: { code: string; fileName: string; language: string } | null = null;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    
    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
        // 启动时自动初始化：加载文档 + 检查模型连接
        this.initialize();
    }

    // 初始化：加载文档向量 + 自动启动模型服务 + 加载reranker
    private async initialize(): Promise<void> {
        const startTime = Date.now();
        console.log('[RAG]初始化开始');

        this.loadKnowledgeGraph();

        await this.loadDocumentsWithEmbeddings();

        let modelOk = await this.checkModelConnection();
        if (!modelOk) {
            console.log('[LLM]模型服务未运行，尝试自动启动...');
            modelOk = await this.startModelServer();
        }

        modelConnected = modelOk;
        console.log(`[LLM]模型连接: ${LLM_MODEL} ${modelOk ? '--success' : '--fail'}`);

        await this.loadReranker();

        initCompleted = true;

        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.webview.postMessage({
                type: 'initComplete',
                modelConnected: modelConnected,
                docsLoaded: docsLoaded,
                chunkCount: docChunks.length
            });
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[RAG]初始化完成 [Model ${modelConnected ? 'OK' : '--'} | ${docChunks.length} chunks | Reranker ${rerankerReady ? 'OK' : '--'} | KG ${kgLoaded ? kgGraph?.order + '节点' : '--'}] ${elapsed}s`);
    }

    // 检查大模型连接
    private async checkModelConnection(): Promise<boolean> {
        try {
            const data = await ollamaRequest(LLM_URL, {
                model: LLM_MODEL,
                messages: [{ role: 'user', content: 'hi' }],
                stream: false
            }, 10000);
            return !!data.message?.content;
        } catch {
            return false;
        }
    }

    private async startModelServer(): Promise<boolean> {
        const serveScript = path.join(this._context.extensionPath, 'finetune', 'serve.py');
        if (!fs.existsSync(serveScript)) {
            console.log('[LLM]serve.py 不存在，跳过自动启动');
            return false;
        }

        const pythonCmd = this.findPython();
        if (!pythonCmd) {
            console.log('[LLM]未找到 Python，无法自动启动模型服务');
            return false;
        }

        const baseModel = path.join(this._context.extensionPath, 'finetune', 'base_model');
        if (!fs.existsSync(baseModel)) {
            console.log('[LLM]未找到基础模型文件，无法启动服务');
            return false;
        }
        console.log('[LLM]使用基础模型 (base_model)');

        try {
            const args = [serveScript, '--port', String(LLM_PORT), '--base_only'];

            modelServerProcess = spawn(pythonCmd, args, {
                cwd: path.join(this._context.extensionPath, 'finetune'),
                stdio: 'pipe',
                detached: false,
                windowsHide: true,
            });

            modelServerProcess.stdout?.on('data', (data: Buffer) => {
                const line = data.toString().trim();
                if (line) {
                    console.log(`[LLM-serve] ${line}`);
                }
            });

            modelServerProcess.stderr?.on('data', (data: Buffer) => {
                const line = data.toString().trim();
                if (line) {
                    console.log(`[LLM-serve] ${line}`);
                }
            });

            modelServerProcess.on('error', (err) => {
                console.log(`[LLM-serve] 进程错误: ${err.message}`);
                modelServerProcess = null;
            });

            modelServerProcess.on('exit', (code) => {
                console.log(`[LLM-serve] 进程退出，code=${code}`);
                modelServerProcess = null;
            });

            console.log(`[LLM]模型服务启动中... (python ${args.join(' ')})`);

            const connected = await this.waitForServerReady();
            if (connected) {
                console.log('[LLM]模型服务自动启动成功');
            } else {
                console.log('[LLM]模型服务启动超时');
            }
            return connected;
        } catch (e) {
            console.log(`[LLM]启动模型服务失败: ${(e as Error).message}`);
            return false;
        }
    }

    private findPython(): string | null {
        const candidates = process.platform === 'win32'
            ? ['python', 'python3', 'py']
            : ['python3', 'python'];

        for (const cmd of candidates) {
            try {
                const result = execFileSync(cmd, ['--version'], { timeout: 5000, windowsHide: true });
                if (result && result.toString().includes('Python')) {
                    return cmd;
                }
            } catch {
                continue;
            }
        }
        return null;
    }

    private async waitForServerReady(): Promise<boolean> {
        const startTime = Date.now();
        const timeoutMs = LLM_STARTUP_TIMEOUT * 1000;

        while (Date.now() - startTime < timeoutMs) {
            await new Promise(r => setTimeout(r, LLM_POLL_INTERVAL));

            try {
                const httpReq = http.request({
                    hostname: 'localhost',
                    port: LLM_PORT,
                    path: '/health',
                    method: 'GET',
                    timeout: 3000,
                }, (res) => {
                    let body = '';
                    res.on('data', (chunk) => { body += chunk; });
                    res.on('end', () => {
                        try {
                            const data = JSON.parse(body);
                            if (data.model_loaded) {
                                return;
                            }
                        } catch {}
                    });
                });
                httpReq.on('error', () => {});
                httpReq.end();

                const ok = await this.checkModelConnection();
                if (ok) {
                    return true;
                }
            } catch {
                // 继续等待
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            console.log(`[LLM]等待模型服务就绪... (${elapsed}s/${LLM_STARTUP_TIMEOUT}s)`);
        }

        return false;
    }

    public static stopModelServer(): void {
        if (modelServerProcess && !modelServerProcess.killed) {
            console.log('[LLM]停止模型服务进程...');
            modelServerProcess.kill();
            modelServerProcess = null;
        }
    }

    private async loadReranker(): Promise<void> {
        if (rerankerModel && rerankerTokenizer) {
            rerankerReady = true;
            return;
        }

        try {
            const modelCacheDir = path.join(this._context.extensionPath, RERANKER_CACHE_DIR);
            if (!fs.existsSync(modelCacheDir)) {
                fs.mkdirSync(modelCacheDir, { recursive: true });
            }

            const transformers = await import('@xenova/transformers');
            transformers.env.cacheDir = modelCacheDir;
            transformers.env.allowLocalModels = true;

            const cachedModelDir = path.join(modelCacheDir, RERANKER_MODEL);
            const isCached = fs.existsSync(path.join(cachedModelDir, 'onnx'));
            const sourceLabel = isCached ? '本地缓存' : '下载(hf-mirror)';

            if (!isCached) {
                transformers.env.remoteHost = 'https://hf-mirror.com/';
            }

            const [model, tokenizer] = await Promise.all([
                transformers.AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, {
                    quantized: true
                }),
                transformers.AutoTokenizer.from_pretrained(RERANKER_MODEL)
            ]);

            rerankerModel = model;
            rerankerTokenizer = tokenizer;
            rerankerReady = true;
            console.log(`[RAG]Reranker: ${RERANKER_MODEL} (${sourceLabel})--success`);
        } catch (e) {
            console.log(`[RAG]Reranker 加载失败: ${(e as Error).message}--fail`);
            rerankerReady = false;
        }
    }

    private loadKnowledgeGraph(): void {
        if (kgLoaded) {
            return;
        }

        try {
            const kgPath = path.join(this._context.extensionPath, 'knowledge_graph.json');
            if (!fs.existsSync(kgPath)) {
                console.log('[KG]知识图谱文件不存在--fail');
                kgLoaded = true;
                return;
            }

            const rawData = JSON.parse(fs.readFileSync(kgPath, 'utf-8'));
            const nodes: any[] = rawData.nodes || [];
            const edges: any[] = rawData.edges || [];

            const graph = new Graph({ type: 'directed', multi: false });

            for (const node of nodes) {
                graph.addNode(node.id, {
                    type: node.type,
                    name: node.name,
                    aliases: node.aliases || [],
                    description: node.description || '',
                    level: node.level || ''
                });
                kgNodesMap.set(node.id, {
                    id: node.id,
                    type: node.type,
                    name: node.name,
                    aliases: node.aliases || [],
                    description: node.description || '',
                    level: node.level
                });

                const namesToIndex = [node.name, ...(node.aliases || [])];
                for (const name of namesToIndex) {
                    const key = name.toLowerCase().trim();
                    if (key.length === 0) continue;
                    if (!kgNameIndex.has(key)) {
                        kgNameIndex.set(key, []);
                    }
                    kgNameIndex.get(key)!.push(node.id);
                }
            }

            let edgeCount = 0;
            for (const edge of edges) {
                try {
                    graph.addEdge(edge.source, edge.target, {
                        relation: edge.relation,
                        weight: edge.weight || 1.0
                    });
                    edgeCount++;
                } catch {
                    // skip duplicate or invalid edges
                }
            }

            kgGraph = graph;
            kgLoaded = true;

            const typeCounts: Record<string, number> = {};
            for (const node of nodes) {
                typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
            }
            const typeSummary = Object.entries(typeCounts).map(([t, c]) => `${t}=${c}`).join(', ');
            console.log(`[KG]知识图谱: ${nodes.length}节点(${typeSummary}) | ${edgeCount}边--success`);
        } catch (e) {
            console.log(`[KG]知识图谱加载失败: ${(e as Error).message}--fail`);
            kgLoaded = true;
        }
    }

    private matchKGEntities(keywords: string[]): string[] {
        if (!kgLoaded || !kgGraph || keywords.length === 0) {
            return [];
        }

        const matchedIds = new Set<string>();

        for (const keyword of keywords) {
            const key = keyword.toLowerCase().trim();
            if (key.length === 0) continue;

            const directMatch = kgNameIndex.get(key);
            if (directMatch) {
                for (const id of directMatch) {
                    matchedIds.add(id);
                }
            }

            if (matchedIds.size >= KG_MAX_MATCHED_NODES) break;

            kgNameIndex.forEach((nodeIds, nameKey) => {
                if (matchedIds.size >= KG_MAX_MATCHED_NODES) return;
                if (nameKey !== key && (nameKey.includes(key) || key.includes(nameKey))) {
                    for (const id of nodeIds) {
                        matchedIds.add(id);
                        if (matchedIds.size >= KG_MAX_MATCHED_NODES) return;
                    }
                }
            });
        }

        return [...matchedIds].slice(0, KG_MAX_MATCHED_NODES);
    }

    private traverseKG(matchedNodeIds: string[], maxHops: number = KG_MAX_HOPS): {
        visited: Map<string, { node: KGNodeData; hops: number; path: string[] }>;
        edges: Array<{ source: string; target: string; relation: string }>
    } {
        if (!kgLoaded || !kgGraph || matchedNodeIds.length === 0) {
            return { visited: new Map(), edges: [] };
        }

        const visited = new Map<string, { node: KGNodeData; hops: number; path: string[] }>();
        const collectedEdges: Array<{ source: string; target: string; relation: string }> = [];
        const queue: Array<{ id: string; hops: number; path: string[] }> = [];

        for (const id of matchedNodeIds) {
            if (kgGraph.hasNode(id) && !visited.has(id)) {
                const nodeData = kgNodesMap.get(id)!;
                visited.set(id, { node: nodeData, hops: 0, path: [id] });
                queue.push({ id, hops: 0, path: [id] });
            }
        }

        while (queue.length > 0) {
            const current = queue.shift()!;

            if (current.hops >= maxHops) continue;

            const outEdges = kgGraph.outEdges(current.id);
            if (outEdges) {
                for (const edge of outEdges) {
                    const target = kgGraph.target(edge);
                    const attrs = kgGraph.getEdgeAttributes(edge) as KGEdgeData;
                    collectedEdges.push({ source: current.id, target, relation: attrs.relation });

                    if (!visited.has(target)) {
                        const targetData = kgNodesMap.get(target);
                        if (targetData) {
                            visited.set(target, { node: targetData, hops: current.hops + 1, path: [...current.path, target] });
                            queue.push({ id: target, hops: current.hops + 1, path: [...current.path, target] });
                        }
                    }
                }
            }

            const inEdges = kgGraph.inEdges(current.id);
            if (inEdges) {
                for (const edge of inEdges) {
                    const source = kgGraph.source(edge);
                    const attrs = kgGraph.getEdgeAttributes(edge) as KGEdgeData;
                    collectedEdges.push({ source, target: current.id, relation: attrs.relation });

                    if (!visited.has(source)) {
                        const sourceData = kgNodesMap.get(source);
                        if (sourceData) {
                            visited.set(source, { node: sourceData, hops: current.hops + 1, path: [...current.path, source] });
                            queue.push({ id: source, hops: current.hops + 1, path: [...current.path, source] });
                        }
                    }
                }
            }
        }

        return { visited, edges: collectedEdges };
    }

    private generateKGContext(matchedNodeIds: string[]): KGContextResult {
        if (!kgLoaded || !kgGraph || matchedNodeIds.length === 0) {
            return { contextText: '', matchedNodes: [], expandedKeywords: [] };
        }

        const { visited, edges } = this.traverseKG(matchedNodeIds, KG_MAX_HOPS);

        if (visited.size === 0) {
            return { contextText: '', matchedNodes: [], expandedKeywords: [] };
        }

        const knowledgeNodes: KGNodeData[] = [];
        const errorNodes: KGNodeData[] = [];
        const solutionNodes: KGNodeData[] = [];
        const symptomNodes: KGNodeData[] = [];
        const toolNodes: KGNodeData[] = [];

        visited.forEach((entry) => {
            switch (entry.node.type) {
                case 'knowledge': knowledgeNodes.push(entry.node); break;
                case 'error': errorNodes.push(entry.node); break;
                case 'solution': solutionNodes.push(entry.node); break;
                case 'symptom': symptomNodes.push(entry.node); break;
                case 'tool': toolNodes.push(entry.node); break;
            }
        });

        const expandedKeywords = new Set<string>();
        visited.forEach((entry) => {
            expandedKeywords.add(entry.node.name);
            for (const alias of entry.node.aliases) {
                expandedKeywords.add(alias);
            }
        });

        let contextText = '知识图谱关联：';

        if (knowledgeNodes.length > 0) {
            contextText += '\n• 涉及知识点：';
            for (const kn of knowledgeNodes.slice(0, 5)) {
                const levelStr = kn.level ? `（${kn.level}）` : '';
                contextText += `\n  - ${kn.name}${levelStr}`;
            }
        }

        if (errorNodes.length > 0) {
            contextText += '\n• 相关错误：';
            for (const err of errorNodes.slice(0, 5)) {
                contextText += `\n  - ${err.name}`;
            }
        }

        const causesEdges = edges.filter(e => e.relation === 'causes').slice(0, 5);
        if (causesEdges.length > 0) {
            contextText += '\n• 因果链：';
            for (const edge of causesEdges) {
                const srcNode = kgNodesMap.get(edge.source);
                const tgtNode = kgNodesMap.get(edge.target);
                if (srcNode && tgtNode) {
                    contextText += `\n  - ${srcNode.name} → 导致 → ${tgtNode.name}`;
                }
            }
        }

        const fixesEdges = edges.filter(e => e.relation === 'fixes').slice(0, 5);
        const detectsEdges = edges.filter(e => e.relation === 'detects').slice(0, 3);
        const allFixEdges = [...fixesEdges, ...detectsEdges];
        if (allFixEdges.length > 0) {
            contextText += '\n• 解决方案：';
            for (const edge of allFixEdges) {
                const srcNode = kgNodesMap.get(edge.source);
                const tgtNode = kgNodesMap.get(edge.target);
                if (srcNode && tgtNode) {
                    const label = edge.relation === 'fixes' ? '修复' : '检测';
                    contextText += `\n  - ${srcNode.name}（${label} ${tgtNode.name}）`;
                }
            }
        }

        const prereqEdges = edges.filter(e => e.relation === 'prerequisite').slice(0, 3);
        if (prereqEdges.length > 0) {
            contextText += '\n• 前置知识：';
            for (const edge of prereqEdges) {
                const srcNode = kgNodesMap.get(edge.source);
                const tgtNode = kgNodesMap.get(edge.target);
                if (srcNode && tgtNode) {
                    contextText += `\n  - ${srcNode.name} → ${tgtNode.name}的前置`;
                }
            }
        }

        if (contextText.length > KG_MAX_CONTEXT_CHARS) {
            contextText = contextText.substring(0, KG_MAX_CONTEXT_CHARS) + '...';
        }

        const limitedKeywords = [...expandedKeywords].slice(0, KG_MAX_EXPANDED_KW);

        console.log(`[KG] 匹配节点=${matchedNodeIds.length} | 遍历节点=${visited.size} | 关联边=${edges.length} | 扩展词=${limitedKeywords.length} | 上下文=${contextText.length}字`);

        return {
            contextText,
            matchedNodes: matchedNodeIds,
            expandedKeywords: limitedKeywords
        };
    }

    private expandQueryWithKG(question: string): { expandedKeywords: string[]; kgContext: KGContextResult } {
        if (!kgLoaded || !kgGraph) {
            return { expandedKeywords: [], kgContext: { contextText: '', matchedNodes: [], expandedKeywords: [] } };
        }

        const keywords = this.extractKeywords(question);
        const matchedIds = this.matchKGEntities(keywords);

        if (matchedIds.length === 0) {
            return { expandedKeywords: [], kgContext: { contextText: '', matchedNodes: [], expandedKeywords: [] } };
        }

        const kgContext = this.generateKGContext(matchedIds);

        const originalKwSet = new Set(keywords.map(k => k.toLowerCase()));
        const extraKeywords = kgContext.expandedKeywords.filter(k => !originalKwSet.has(k.toLowerCase()));

        return { expandedKeywords: extraKeywords, kgContext };
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
                    case 'syntaxCheck':
                        this.handleSyntaxCheck();
                        break;
                    case 'learningPath':
                        this.handleLearningPath();
                        break;
                }
            },
            undefined,
            this._context.subscriptions
        );
    }

    // 调用 Ollama 多轮对话接口（自动注入系统提示到最前）
    private async callOllama(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
        // 移除历史中可能存在的旧系统消息，插入最新的系统提示到最前
        const messagesWithoutSystem = messages.filter(m => m.role !== 'system');
        const finalMessages = [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...messagesWithoutSystem];

        console.log('[LLM] ═══════════════════════════════');
        console.log(`[LLM] 发送消息数: ${finalMessages.length}`);
        for (let i = 0; i < finalMessages.length; i++) {
            const msg = finalMessages[i];
            console.log(`[LLM] [${i}] role=${msg.role} | 长度=${msg.content.length}`);
            console.log(msg.content);
            console.log('---');
        }
        console.log('[LLM] ═══════════════════════════════');

        try {
            const data = await ollamaRequest(LLM_URL, {
                model: LLM_MODEL,
                messages: finalMessages,
                stream: false
            }, 120000);
            return data.message?.content || '未收到有效响应';
        } catch (e) {
            return '调用大模型失败: ' + (e as Error).message;
        }
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

            if (!fs.existsSync(documentsPath)) {
                console.log(`[RAG]文档目录不存在: ${documentsPath}--fail`);
                docsLoaded = true;
                return;
            }

            const cacheDir = this.getCacheDir();
            const files = fs.readdirSync(documentsPath).filter(f => {
                const ext = path.extname(f).toLowerCase();
                return ext === '.txt' || ext === '.md';
            });

            if (files.length === 0) {
                console.log('[RAG]文档目录为空 (无 .txt/.md 文件)--fail');
                docsLoaded = true;
                return;
            }

            console.log(`[RAG]   文档目录: ${documentsPath} (${files.length} files)`);
            console.log(`[RAG]   开始进行向量生成`);

            let totalChunks = 0;
            let cachedCount = 0;
            let generatedCount = 0;
            const newDocChunks: DocChunk[] = [];

            for (const file of files) {
                const filePath = path.join(documentsPath, file);
                const fileHash = this.getFileHash(filePath);
                const cacheFile = path.join(cacheDir, `${file}.json`);

                if (fs.existsSync(cacheFile)) {
                    try {
                        const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
                        if (cacheData.hash === fileHash && cacheData.embedModel === EMBED_MODEL && cacheData.chunkSize === CHUNK_SIZE && cacheData.chunkOverlap === CHUNK_OVERLAP && Array.isArray(cacheData.chunks)) {
                            newDocChunks.push(...cacheData.chunks);
                            totalChunks += cacheData.chunks.length;
                            cachedCount++;
                            console.log(`[RAG]   ├─ ${file} → ${cacheData.chunks.length} chunks (缓存)`);
                            continue;
                        }
                    } catch {
                        // 缓存损坏，重新生成
                    }
                }

                const content = fs.readFileSync(filePath, 'utf-8');
                const isMarkdown = file.toLowerCase().endsWith('.md');
                const splitter = isMarkdown
                    ? new MarkdownTextSplitter({ chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP })
                    : new RecursiveCharacterTextSplitter({ chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP });
                const chunks = await splitter.splitText(content);

                const fileChunks: DocChunk[] = [];
                for (const chunkContent of chunks) {
                    const embedding = await this.generateEmbedding(chunkContent);
                    if (embedding.length > 0) {
                        const docChunk = { fileName: file, content: chunkContent, embedding };
                        fileChunks.push(docChunk);
                        newDocChunks.push(docChunk);
                        totalChunks++;
                    }
                }
                generatedCount++;

                const label = chunks.length > 0 ? `${chunks.length} chunks (生成)` : '空文件';
                console.log(`[RAG]   ├─ ${file} → ${label}`);

                try {
                    const cacheData = {
                        hash: fileHash,
                        embedModel: EMBED_MODEL,
                        chunkSize: CHUNK_SIZE,
                        chunkOverlap: CHUNK_OVERLAP,
                        chunks: fileChunks,
                        timestamp: Date.now()
                    };
                    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
                } catch {
                    // 缓存写入失败不阻塞
                }
            }

            // 清理已删除文件的缓存
            const cacheFiles = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
            for (const cacheFile of cacheFiles) {
                const fileName = cacheFile.replace('.json', '');
                if (!files.includes(fileName)) {
                    fs.unlinkSync(path.join(cacheDir, cacheFile));
                }
            }

            docChunks = newDocChunks;
            this.buildBM25Index();
            docsLoaded = true;

            const summary = cachedCount > 0 && generatedCount > 0
                ? `${cachedCount}缓存+${generatedCount}生成`
                : cachedCount > 0 ? `${cachedCount}缓存` : `${generatedCount}生成`;
            console.log(`[RAG]向量索引: ${totalChunks} chunks | embed=${EMBED_MODEL} (${summary})--success`);
        } catch (error) {
            console.error('[RAG]文档加载失败--fail', error);
            docsLoaded = true;
        }
    }

    // 生成向量
    private async generateEmbedding(text: string, retries: number = 2): Promise<number[]> {
        const attempt = async (remainingRetries: number): Promise<number[]> => {
            try {
                const data = await ollamaRequest(OLLAMA_EMBED_URL, {
                    model: EMBED_MODEL,
                    prompt: text
                }, 120000);
                const embedding = data.embedding || [];
                if (embedding.length === 0) {
                    if (remainingRetries > 0) {
                        await new Promise(r => setTimeout(r, 1000));
                        return attempt(remainingRetries - 1);
                    }
                    console.log(`[RAG]Embedding 返回空 (重试已耗尽)--fail`);
                    return [];
                }
                return embedding;
            } catch (e) {
                if (remainingRetries > 0) {
                    await new Promise(r => setTimeout(r, 1000));
                    return attempt(remainingRetries - 1);
                }
                console.log(`[RAG]Embedding 失败 (重试已耗尽): ${(e as Error).message}--fail`);
                return [];
            }
        };
        return attempt(retries);
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
    private async retrieveRelevantDocs(question: string, extraKeywords: string[] = []): Promise<{
        contextText: string;
        fileNames: string[];
        retrievalDetails: RetrievalResult[];
    }> {
        if (!docsLoaded) {
            await this.loadDocumentsWithEmbeddings();
        }

        if (docChunks.length === 0) {
            return { contextText: '', fileNames: [], retrievalDetails: [] };
        }

        const keywords = this.extractKeywords(question);
        const allKeywords = [...keywords, ...extraKeywords];

        // 计算问题向量
        const questionEmbedding = await this.generateEmbedding(question);
        let useVector = questionEmbedding.length > 0;

        // 计算向量检索排名（预过滤 similarity ≥ VECTOR_THRESHOLD）
        const vectorCandidates = docChunks.map(chunk => {
            const score = (useVector && chunk.embedding.length > 0) 
                ? this.cosineSimilarity(questionEmbedding, chunk.embedding) : 0;
            return { chunk, score };
        }).filter(item => item.score >= VECTOR_THRESHOLD);

        const vectorSorted = vectorCandidates.sort((a, b) => b.score - a.score);
        const vectorRankMap = new Map<DocChunk, number>();
        vectorSorted.forEach((item, index) => {
            vectorRankMap.set(item.chunk, index + 1);
        });

        // 计算关键词检索排名（使用BM25算法，含KG扩展词）
        const keywordCandidates = docChunks.map((chunk, index) => {
            const score = this.calculateBM25Score(allKeywords, index);
            return { chunk, score };
        }).filter(item => item.score >= BM25_MIN_SCORE);

        const keywordSorted = keywordCandidates.sort((a, b) => b.score - a.score);
        const keywordRankMap = new Map<DocChunk, number>();
        const keywordScoreMap = new Map<DocChunk, number>();
        keywordSorted.forEach((item, index) => {
            keywordRankMap.set(item.chunk, index + 1);
            keywordScoreMap.set(item.chunk, item.score);
        });

        // 取A∪B，计算RRF分数
        const candidateChunks = new Set<DocChunk>();
        vectorRankMap.forEach((rank, chunk) => candidateChunks.add(chunk));
        keywordRankMap.forEach((rank, chunk) => candidateChunks.add(chunk));

        const results = Array.from(candidateChunks).map(chunk => {
            const rankVector = vectorRankMap.get(chunk) || Number.MAX_SAFE_INTEGER;
            const rankKeyword = keywordRankMap.get(chunk) || Number.MAX_SAFE_INTEGER;

            const rrfVector = rankVector !== Number.MAX_SAFE_INTEGER ? 1 / (RRF_K + rankVector) : 0;
            const rrfKeyword = rankKeyword !== Number.MAX_SAFE_INTEGER ? 1 / (RRF_K + rankKeyword) : 0;
            const rrfScore = rrfVector * RRF_VECTOR_WEIGHT + rrfKeyword * RRF_KEYWORD_WEIGHT;

            return { chunk, rrfScore, rankVector, rankKeyword, rrfVector, rrfKeyword };
        });

        // 按RRF分数排序，取Top K作为候选
        const rrfResults = results
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .slice(0, RRF_TOP_K);

        const rrfScoreMap = new Map<DocChunk, number>();
        rrfResults.forEach(r => rrfScoreMap.set(r.chunk, r.rrfScore));

        if (rrfResults.length === 0) {
            return { contextText: '', fileNames: [], retrievalDetails: [] };
        }

        // 对RRF候选结果进行rerank，选出最终top k
        const rerankedResults = await this.rerankDocs(question, rrfResults);

        if (rerankedResults.length === 0) {
            return { contextText: '', fileNames: [], retrievalDetails: [] };
        }

        const fileNames = [...new Set(rerankedResults.map(r => r.chunk.fileName))];
        let contextText = '参考文档：';
        const retrievalDetails: RetrievalResult[] = [];

        for (let i = 0; i < rerankedResults.length; i++) {
            const result = rerankedResults[i];
            if (i > 0 && i % 2 === 0) {
                contextText += '\n';
            }
            contextText += `\n${result.chunk.content}`;
            const originalRrfScore = rrfScoreMap.get(result.chunk) || result.rerankScore;
            retrievalDetails.push({
                fileName: result.chunk.fileName,
                content: result.chunk.content,
                vectorScore: result.rankVector !== undefined && result.rankVector !== Number.MAX_SAFE_INTEGER ?
                    this.cosineSimilarity(questionEmbedding, result.chunk.embedding) : undefined,
                keywordScore: result.rankKeyword !== undefined && result.rankKeyword !== Number.MAX_SAFE_INTEGER ?
                    keywordScoreMap.get(result.chunk) || undefined : undefined,
                rrfScore: originalRrfScore,
                rankVector: result.rankVector !== undefined && result.rankVector !== Number.MAX_SAFE_INTEGER ? result.rankVector : undefined,
                rankKeyword: result.rankKeyword !== undefined && result.rankKeyword !== Number.MAX_SAFE_INTEGER ? result.rankKeyword : undefined
            });
        }

        const kwStr = keywords.length > 0 ? keywords.join(', ') : '(无)';
        const extraKwStr = extraKeywords.length > 0 ? ` + KG扩展[${extraKeywords.join(', ')}]` : '';
        console.log(`[RAG] ─── 检索 ───`);
        console.log(`[RAG] Query: "${question}"`);
        console.log(`[RAG] Keywords: [${kwStr}]${extraKwStr}`);
        console.log(`[RAG] 向量候选=${vectorCandidates.length} | BM25候选=${keywordCandidates.length} | 合并=${candidateChunks.size}`);
        console.log(`[RAG] RRF→Rerank: Top${RRF_TOP_K}→Top${RERANK_TOP_K} | 命中: ${fileNames.join(', ')}`);

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
            }
        } catch {
            // 停用词加载失败使用空集
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

        for (const chunk of docChunks) {
            let words: string[] = [];
            try {
                words = nodejieba.cut(chunk.content)
                    .map(w => w.trim().toLowerCase())
                    .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !stopWords.has(w));
            } catch {
                words = chunk.content.split(/[\s\.,;:!?，。；：！？]+/)
                    .map(w => w.toLowerCase())
                    .filter(w => w.length >= 2 && !stopWords.has(w));
            }

            const termFreq = new Map<string, number>();
            for (const word of words) {
                termFreq.set(word, (termFreq.get(word) || 0) + 1);
            }
            this.docTermFreqs.push(termFreq);

            const uniqueWords = new Set(words);
            for (const word of uniqueWords) {
                this.docFreqs.set(word, (this.docFreqs.get(word) || 0) + 1);
            }

            totalLength += words.length;
        }

        this.totalDocs = docChunks.length;
        this.avgdl = totalLength / this.totalDocs;
        this.bm25Ready = true;
        console.log(`[RAG]BM25索引: ${this.totalDocs} docs, avgdl=${this.avgdl.toFixed(1)} | 停用词=${stopWords.size}--success`);
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

            // Lucene BM25 IDF: log(1 + (N - df + 0.5) / (df + 0.5))
            // 避免标准BM25中 df > N/2 时IDF为负数导致高频词惩罚文档的问题
            const idf = Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5));

            // BM25公式: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)))
            const numerator = tf * (BM25_K1 + 1);
            const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / this.avgdl));
            score += idf * (numerator / denominator);
        }

        return score;
    }

    private async crossEncoderScore(question: string, document: string): Promise<number> {
        if (!rerankerModel || !rerankerTokenizer) {
            return 0;
        }

        try {
            const inputs = rerankerTokenizer._call(question, {
                text_pair: document,
                padding: true,
                truncation: true,
                max_length: 512,
                return_tensors: true,
            });

            const outputs = await rerankerModel._call(inputs);
            const logitsData = outputs.logits.data;
            const score = logitsData[0];
            return typeof score === 'number' && isFinite(score) ? score : 0;
        } catch {
            return 0;
        }
    }

    private async rerankDocs(question: string, candidates: Array<{chunk: DocChunk, rrfScore: number, rankVector?: number, rankKeyword?: number}>): Promise<Array<{chunk: DocChunk, rerankScore: number, rankVector?: number, rankKeyword?: number}>> {
        if (candidates.length <= RERANK_TOP_K) {
            return candidates.map(c => ({ chunk: c.chunk, rerankScore: c.rrfScore, rankVector: c.rankVector, rankKeyword: c.rankKeyword }));
        }

        if (!rerankerReady) {
            return candidates.slice(0, RERANK_TOP_K).map(c => ({
                chunk: c.chunk,
                rerankScore: c.rrfScore,
                rankVector: c.rankVector,
                rankKeyword: c.rankKeyword
            }));
        }

        if (!rerankerModel || !rerankerTokenizer) {
            await this.loadReranker();
            if (!rerankerModel || !rerankerTokenizer) {
                return candidates.slice(0, RERANK_TOP_K).map(c => ({
                    chunk: c.chunk,
                    rerankScore: c.rrfScore,
                    rankVector: c.rankVector,
                    rankKeyword: c.rankKeyword
                }));
            }
        }

        try {
            const scores = await Promise.all(
                candidates.map(candidate => this.crossEncoderScore(question, candidate.chunk.content))
            );

            let maxScore = -Infinity;
            let minScore = Infinity;
            let maxRrf = -Infinity;
            let minRrf = Infinity;
            for (let i = 0; i < scores.length; i++) {
                if (scores[i] > maxScore) maxScore = scores[i];
                if (scores[i] < minScore) minScore = scores[i];
                if (candidates[i].rrfScore > maxRrf) maxRrf = candidates[i].rrfScore;
                if (candidates[i].rrfScore < minRrf) minRrf = candidates[i].rrfScore;
            }
            const scoreRange = maxScore - minScore || 1;
            const rrfRange = maxRrf - minRrf || 1;

            const scoredCandidates = candidates.map((candidate, idx) => {
                const normalizedRerank = (scores[idx] - minScore) / scoreRange;
                const normalizedRrf = (candidate.rrfScore - minRrf) / rrfRange;
                return {
                    ...candidate,
                    rerankScore: normalizedRerank * 0.8 + normalizedRrf * 0.2
                };
            });

            return scoredCandidates
                .sort((a, b) => b.rerankScore - a.rerankScore)
                .slice(0, RERANK_TOP_K);
        } catch {
            return candidates.slice(0, RERANK_TOP_K).map(c => ({
                chunk: c.chunk,
                rerankScore: c.rrfScore,
                rankVector: c.rankVector,
                rankKeyword: c.rankKeyword
            }));
        }
    }

    // 提取关键词（使用jieba分词+停用词过滤）
    private extractKeywords(text: string): string[] {
        const keywords: Set<string> = new Set();
        const stopWords = this.loadStopWords();

        // 使用jieba分词处理中文
        try {
            const jiebaWords = nodejieba.cut(text);
            for (const word of jiebaWords) {
                const w = word.trim().toLowerCase();
                if (w.length >= 2 && !stopWords.has(w) && !/^\d+$/.test(w)) {
                    keywords.add(w);
                }
            }
        } catch {
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
            const { expandedKeywords, kgContext } = this.expandQueryWithKG(question);

            const ragResult = await this.retrieveRelevantDocs(question, expandedKeywords);
            const hasRagDocs = ragResult.fileNames.length > 0;
            const hasKGContext = kgContext.contextText.length > 0;
            
            let historyContent = `用户问题：${question}`;

            if (hasContext && AiAssistantViewProvider.selectedCodeContext) {
                const ctx = AiAssistantViewProvider.selectedCodeContext;
                historyContent += `\n\n用户提供的代码：\n${ctx.code}`;
                AiAssistantViewProvider.selectedCodeContext = null;
            } else {
                historyContent += '\n\n用户提供的代码：空';
            }

            this.conversationHistory.push({ role: 'user', content: historyContent });

            const messagesForLLM = [...this.conversationHistory];
            const lastIdx = messagesForLLM.length - 1;
            let llmContent = historyContent;
            if (hasKGContext) {
                llmContent += `\n\n${kgContext.contextText}`;
            } else {
                llmContent += '\n\n知识图谱关联：空';
            }
            if (hasRagDocs) {
                llmContent += `\n\n${ragResult.contextText}`;
            } else {
                llmContent += '\n\n参考文档：空';
            }
            messagesForLLM[lastIdx] = {
                ...messagesForLLM[lastIdx],
                content: llmContent
            };

            const rawAnswer = await this.callOllama(messagesForLLM);

            this.conversationHistory.push({ role: 'assistant', content: rawAnswer });

            let finalAnswer = rawAnswer;
            const sources: string[] = [];
            if (hasKGContext) {
                sources.push(`知识图谱(${kgContext.matchedNodes.length}个匹配节点)`);
            }
            if (hasRagDocs) {
                sources.push(`知识库文档: ${ragResult.fileNames.join(", ")}`);
            }
            finalAnswer += sources.length > 0 ? `\n\n📚 来源：${sources.join(' | ')}` : '\n\n📚 来源：无';

            if (AiAssistantViewProvider.currentPanel) {
                AiAssistantViewProvider.currentPanel.webview.postMessage({
                    type: 'aiResponse',
                    response: finalAnswer,
                    hasContext: hasContext,
                    retrievalDetails: ragResult.retrievalDetails || [],
                    kgMatchedNodes: hasKGContext ? kgContext.matchedNodes : []
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

    private async handleSyntaxCheck() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开一个C语言源文件，再进行语法检查。');
            return;
        }

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);
        const fullText = editor.document.getText();
        const fileName = editor.document.fileName.split(/[\\/]/).pop() || 'unknown';
        const language = editor.document.languageId;

        const items: vscode.QuickPickItem[] = [];
        if (selectedText) {
            items.push({
                label: '$(code) 检查选中代码',
                description: `${selectedText.split('\n').length} 行`,
                detail: selectedText.length > 60 ? selectedText.substring(0, 60) + '...' : selectedText
            });
        }
        items.push({
            label: '$(file-code) 检查整个文件',
            description: `${fileName} · ${fullText.split('\n').length} 行`
        });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: '选择语法检查范围',
            title: '🔍 代码语法检查'
        });

        if (!picked) {
            return;
        }

        const checkSelected = selectedText && picked.label.includes('选中');
        const code = checkSelected ? selectedText : fullText;
        const checkScope = checkSelected ? '选中代码' : '整个文件';

        this.postUserAction(`🔍 语法检查 — ${fileName}（${checkScope}）`);
        this.setLoading(true);

        try {
            let gccOutput = '';
            let gccAvailable = false;
            try {
                gccOutput = await this.runGccCheck(code);
                gccAvailable = true;
            } catch {
                gccAvailable = false;
            }

            const { kgContext } = this.expandQueryWithKG(code.substring(0, 500));

            let userContent = `请对以下代码进行全面语法检查：\n\n文件：${fileName}\n语言：${language}\n\n代码：\n\`\`\`c\n${code}\n\`\`\``;
            if (gccAvailable && gccOutput.trim()) {
                userContent += `\n\nGCC编译器输出：\n\`\`\`\n${gccOutput}\n\`\`\``;
            }
            if (kgContext.contextText) {
                userContent += `\n\n${kgContext.contextText}`;
            }

            const messages = [
                { role: 'system' as const, content: SYNTAX_CHECK_PROMPT },
                { role: 'user' as const, content: userContent }
            ];

            const rawAnswer = await this.callOllamaWithPrompt(messages);

            let finalAnswer = `🔍 **语法检查结果** — ${fileName}`;
            if (gccAvailable) {
                finalAnswer += gccOutput.trim() ? '（编译器发现错误）' : '（编译器检查通过）';
            } else {
                finalAnswer += '（AI审查模式）';
            }
            finalAnswer += '\n\n' + rawAnswer;

            this.conversationHistory.push({ role: 'user', content: `[语法检查] ${fileName}（${checkScope}）` });
            this.conversationHistory.push({ role: 'assistant', content: rawAnswer });

            this.postAiResponse(finalAnswer, true, false, 'syntaxCheck');
        } catch (error) {
            const errorMessage = error instanceof Error ? '错误: ' + error.message : '发生未知错误';
            this.postAiResponse(errorMessage, false, true, 'syntaxCheck');
        } finally {
            this.setLoading(false);
        }
    }

    private async handleLearningPath() {
        const userInput = await vscode.window.showInputBox({
            prompt: '请描述你当前的学习进度或想深入了解的方向',
            placeHolder: '例如：刚学完指针，对链表不太理解；或者：想了解文件操作相关的知识',
            title: '📚 个性化学习路径',
        });

        if (!userInput) {
            return;
        }

        this.postUserAction(`📚 ${userInput}`);
        this.setLoading(true);

        try {
            const historySummary = this.summarizeHistory();
            const { expandedKeywords, kgContext } = this.expandQueryWithKG(userInput);
            const ragResult = await this.retrieveRelevantDocs('C语言学习路径 编程基础 知识点 教程', expandedKeywords);
            const hasRagDocs = ragResult.fileNames.length > 0;
            const hasKGContext = kgContext.contextText.length > 0;

            let userContent = `学生的学习需求：${userInput}\n\n学习记录：\n${historySummary}`;
            if (hasKGContext) {
                userContent += `\n\n${kgContext.contextText}`;
            }
            if (hasRagDocs) {
                userContent += `\n\n${ragResult.contextText}`;
            }

            const messages = [
                { role: 'system' as const, content: LEARNING_PATH_PROMPT },
                { role: 'user' as const, content: userContent }
            ];

            const rawAnswer = await this.callOllamaWithPrompt(messages);

            let finalAnswer = '📚 **个性化学习路径推荐**\n\n' + rawAnswer;
            if (hasRagDocs) {
                finalAnswer += `\n\n📖 参考知识库：${ragResult.fileNames.join(', ')}`;
            }

            this.conversationHistory.push({ role: 'user', content: `[学习路径] ${userInput}` });
            this.conversationHistory.push({ role: 'assistant', content: rawAnswer });

            this.postAiResponse(finalAnswer, false, false, 'learningPath', ragResult.retrievalDetails || []);
        } catch (error) {
            const errorMessage = error instanceof Error ? '错误: ' + error.message : '发生未知错误';
            this.postAiResponse(errorMessage, false, true, 'learningPath');
        } finally {
            this.setLoading(false);
        }
    }

    private postUserAction(text: string) {
        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.webview.postMessage({ type: 'userAction', text });
        }
    }

    private setLoading(loading: boolean) {
        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.webview.postMessage({ type: 'loading', isLoading: loading });
        }
    }

    private postAiResponse(response: string, hasContext: boolean, isError: boolean, featureType: string, retrievalDetails?: any[]) {
        if (AiAssistantViewProvider.currentPanel) {
            const msg: any = { type: 'aiResponse', response, hasContext, isError, featureType };
            if (retrievalDetails && retrievalDetails.length > 0) {
                msg.retrievalDetails = retrievalDetails;
            }
            AiAssistantViewProvider.currentPanel.webview.postMessage(msg);
        }
    }

    private async runGccCheck(code: string): Promise<string> {
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `ai_check_${Date.now()}.c`);

        try {
            fs.writeFileSync(tmpFile, code, 'utf-8');
            console.log(`[GCC] 临时文件: ${tmpFile}, 代码长度: ${code.length}`);

            const gccCmd = process.platform === 'win32' ? 'gcc.exe' : 'gcc';

            return new Promise<string>((resolve, reject) => {
                execFile(gccCmd, ['-fsyntax-only', '-Wall', '-Wextra', '-std=c11', tmpFile],
                    { timeout: 10000 },
                    (error, stdout, stderr) => {
                        try { fs.unlinkSync(tmpFile); } catch {}
                        const out = (stdout || '').toString();
                        const err = (stderr || '').toString();
                        console.log(`[GCC] exitCode=${error?.code ?? 0}, stderr=${err.substring(0, 200)}`);
                        if (error) {
                            const output = (err || out).replace(new RegExp(tmpFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'source.c');
                            resolve(output);
                        } else {
                            resolve('');
                        }
                    }
                );
            });
        } catch {
            try { fs.unlinkSync(tmpFile); } catch {}
            return Promise.reject(new Error('GCC not available'));
        }
    }

    private summarizeHistory(): string {
        if (this.conversationHistory.length <= 1) {
            return '暂无学习记录，这是第一次使用AI助教。请根据一般初学者的常见问题进行推荐。';
        }

        const items: string[] = [];
        for (const msg of this.conversationHistory) {
            if (msg.role === 'user') {
                const qMatch = msg.content.match(/用户问题：(.*?)(?:\n\n|$)/s);
                if (qMatch) {
                    const q = qMatch[1].trim();
                    const hasCode = msg.content.includes('用户提供的代码：\n') && !msg.content.includes('用户提供的代码：空');
                    items.push(`- ${q}${hasCode ? '（附代码）' : ''}`);
                } else if (msg.content.startsWith('[语法检查]')) {
                    items.push(`- ${msg.content}`);
                } else if (msg.content.startsWith('[学习路径推荐]')) {
                    items.push(`- ${msg.content}`);
                }
            }
        }

        if (items.length === 0) {
            return '暂无学习记录，这是第一次使用AI助教。请根据一般初学者的常见问题进行推荐。';
        }

        return `学生的提问记录（共${items.length}条）：\n${items.join('\n')}`;
    }

    private async callOllamaWithPrompt(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
        console.log('[LLM] 专用功能调用');
        console.log(`[LLM] 消息数: ${messages.length}`);
        for (const msg of messages) {
            console.log(`[LLM] --- ${msg.role.toUpperCase()} ---`);
            console.log(msg.content);
        }

        try {
            const data = await ollamaRequest(LLM_URL, {
                model: LLM_MODEL,
                messages: messages,
                stream: false
            }, 120000);
            return data.message?.content || '未收到有效响应';
        } catch (e) {
            return '调用大模型失败: ' + (e as Error).message;
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

    public static triggerFeature(featureType: string) {
        if (AiAssistantViewProvider.currentPanel) {
            AiAssistantViewProvider.currentPanel.webview.postMessage({
                type: 'triggerFeature',
                featureType: featureType
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
                        <h1>AI 编程助教</h1>
                        <p>C语言程序设计 · 智能辅导</p>
                    </header>
                    
                    <div id="code-context" class="code-context" style="display: none;">
                        <div class="code-context-header">
                            <span id="context-label">代码上下文</span>
                            <button id="clear-context" class="clear-context-btn">×</button>
                        </div>
                        <pre id="selected-code"></pre>
                        <div id="context-info"></div>
                    </div>
                    
                    <div id="chat-container" class="chat-container">
                        <div id="chat-messages" class="chat-messages"></div>
                    </div>
                    
                    <div class="input-container">
                        <div class="quick-actions">
                            <button id="syntax-check-btn" class="action-btn" title="对当前文件或选中代码进行语法检查">🔍 语法检查</button>
                            <button id="learning-path-btn" class="action-btn" title="根据学习记录推荐个性化学习路径">📚 学习路径</button>
                        </div>
                        <textarea id="question-input" placeholder="输入你的编程问题..." rows="3"></textarea>
                        <div class="button-container">
                            <button id="ask-button" class="primary-button">发送</button>
                            <button id="clear-button" class="secondary-button">清空</button>
                        </div>
                    </div>
                    
                    <div class="status-bar">
                        <span id="status">就绪</span>
                    </div>
                </div>
                
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}