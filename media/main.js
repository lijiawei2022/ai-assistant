(function() {
    const vscode = acquireVsCodeApi();
    
    const chatMessages = document.getElementById('chat-messages');
    const questionInput = document.getElementById('question-input');
    const askButton = document.getElementById('ask-button');
    const clearButton = document.getElementById('clear-button');
    const statusElement = document.getElementById('status');
    const codeContext = document.getElementById('code-context');
    const selectedCodeEl = document.getElementById('selected-code');
    const contextInfo = document.getElementById('context-info');
    const clearContextBtn = document.getElementById('clear-context');

    let hasSelectedCode = false;
    let isLoading = false;
    let loadingMessageEl = null;

    function setLoading(loading) {
        isLoading = loading;
        askButton.disabled = loading;
        questionInput.disabled = loading;
        
        if (loading) {
            loadingMessageEl = document.createElement('div');
            loadingMessageEl.className = 'message ai-message loading-message';
            loadingMessageEl.innerHTML = `
                <div class="message-label">AI Assistant:</div>
                <div class="message-content">
                    <span class="loading-dots">思考中<span>.</span><span>.</span><span>.</span></span>
                </div>
            `;
            chatMessages.appendChild(loadingMessageEl);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            statusElement.textContent = 'AI 正在思考中...';
        } else {
            if (loadingMessageEl) {
                loadingMessageEl.remove();
                loadingMessageEl = null;
            }
        }
    }

    function displaySelectedCode(code, fileName, language) {
        hasSelectedCode = true;
        let displayCode = code;
        if (code.length > 500) {
            displayCode = code.substring(0, 500) + '... (truncated)';
        }
        selectedCodeEl.textContent = displayCode;
        contextInfo.textContent = `📄 ${fileName} • ${language} • ${code.split('\n').length} lines`;
        codeContext.style.display = 'block';
        statusElement.textContent = 'Code context loaded';
    }

    function addMessage(text, isUser = false, isError = false, retrievalDetails = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isUser ? 'user-message' : 'ai-message'}`;
        if (isError) messageDiv.classList.add('error-message');
        
        const label = document.createElement('div');
        label.className = 'message-label';
        label.textContent = isUser ? 'You:' : 'AI Assistant:';
        
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        content.style.whiteSpace = 'pre-wrap';
        
        messageDiv.appendChild(label);
        messageDiv.appendChild(content);
        
        // 如果有检索详情，添加调试面板
        if (!isUser && retrievalDetails && retrievalDetails.length > 0) {
            const debugPanel = createDebugPanel(retrievalDetails);
            messageDiv.appendChild(debugPanel);
        }
        
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    function createDebugPanel(details) {
        const panel = document.createElement('details');
        panel.className = 'debug-panel';
        panel.open = false;
        
        const summary = document.createElement('summary');
        summary.className = 'debug-summary';
        summary.textContent = `🔍 检索详情 (${details.length} 个文档块)`;
        
        const content = document.createElement('div');
        content.className = 'debug-content';
        
        details.forEach((doc, index) => {
            const docDiv = document.createElement('div');
            docDiv.className = 'debug-doc';
            
            // 分数信息
            const scoresDiv = document.createElement('div');
            scoresDiv.className = 'debug-scores';
            let scoreText = `RRF: ${doc.rrfScore.toFixed(4)}`;
            if (doc.vectorScore !== undefined) {
                scoreText += ` | 向量: ${doc.vectorScore.toFixed(4)}`;
            }
            if (doc.keywordScore !== undefined) {
                scoreText += ` | 关键词: ${doc.keywordScore}`;
            }
            scoresDiv.textContent = `📊 ${scoreText}`;
            
            // 文档内容
            const contentDiv = document.createElement('div');
            contentDiv.className = 'debug-doc-content';
            const displayContent = doc.content.length > 300 ? 
                doc.content.substring(0, 300) + '...' : doc.content;
            contentDiv.textContent = displayContent;
            
            // 文件信息
            const fileDiv = document.createElement('div');
            fileDiv.className = 'debug-file';
            fileDiv.textContent = `📄 ${doc.fileName}`;
            
            docDiv.appendChild(scoresDiv);
            docDiv.appendChild(fileDiv);
            docDiv.appendChild(contentDiv);
            content.appendChild(docDiv);
        });
        
        panel.appendChild(summary);
        panel.appendChild(content);
        return panel;
    }

    function clearChat() {
        chatMessages.innerHTML = '';
        statusElement.textContent = 'Chat cleared';
    }

    function sendQuestion() {
        if (isLoading) return;
        const question = questionInput.value.trim();
        if (!question) return;
        
        addMessage(question, true);
        questionInput.value = '';
        statusElement.textContent = 'Sending to AI...';
        
        vscode.postMessage({
            type: 'askQuestion',
            question: question,
            hasContext: hasSelectedCode
        });
    }

    askButton.addEventListener('click', sendQuestion);
    clearButton.addEventListener('click', () => {
        clearChat();
        vscode.postMessage({ type: 'clearChat' });
    });
    clearContextBtn.addEventListener('click', () => {
        hasSelectedCode = false;
        codeContext.style.display = 'none';
    });
    questionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendQuestion();
        }
    });

    window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
            case 'aiResponse':
                addMessage(message.response, false, message.isError, message.retrievalDetails);
                statusElement.textContent = 'Response received';
                break;
            case 'selectedCode':
                displaySelectedCode(message.code, message.fileName, message.language);
                break;
            case 'loading':
                setLoading(message.isLoading);
                break;
        }
    });

    addMessage('Hello! I am your AI coding assistant. Ask me anything!', false);
})();