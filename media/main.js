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
    const syntaxCheckBtn = document.getElementById('syntax-check-btn');
    const learningPathBtn = document.getElementById('learning-path-btn');

    let hasSelectedCode = false;
    let isLoading = false;
    let loadingMessageEl = null;

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function renderMarkdown(text) {
        let html = escapeHtml(text);

        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
            return '<pre class="code-block"><code class="lang-' + (lang || 'text') + '">' + code.trim() + '</code></pre>';
        });

        html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

        html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

        html = html.replace(/^(\s*)- (.+)$/gm, '$1• $2');

        html = html.replace(/^(\s*)\d+\. (.+)$/gm, '$1$2');

        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');

        html = '<p>' + html + '</p>';
        html = html.replace(/<p>\s*<\/p>/g, '');
        html = html.replace(/<p>\s*(<h[2-4]>)/g, '$1');
        html = html.replace(/(<\/h[2-4]>)\s*<\/p>/g, '$1');
        html = html.replace(/<p>\s*(<pre)/g, '$1');
        html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');

        return html;
    }

    function setLoading(loading) {
        isLoading = loading;
        askButton.disabled = loading;
        questionInput.disabled = loading;
        if (syntaxCheckBtn) syntaxCheckBtn.disabled = loading;
        if (learningPathBtn) learningPathBtn.disabled = loading;

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

    function addMessage(text, isUser, isError, retrievalDetails, featureType) {
        const messageDiv = document.createElement('div');
        let className = `message ${isUser ? 'user-message' : 'ai-message'}`;
        if (isError) className += ' error-message';
        if (featureType === 'syntaxCheck') className += ' syntax-check-message';
        if (featureType === 'learningPath') className += ' learning-path-message';
        messageDiv.className = className;

        const label = document.createElement('div');
        label.className = 'message-label';
        if (isUser) {
            label.textContent = 'You:';
        } else if (featureType === 'syntaxCheck') {
            label.textContent = '🔍 语法检查:';
        } else if (featureType === 'learningPath') {
            label.textContent = '📚 学习路径:';
        } else {
            label.textContent = 'AI Assistant:';
        }

        const content = document.createElement('div');
        content.className = 'message-content markdown-body';

        if (isUser || isError) {
            content.textContent = text;
            content.style.whiteSpace = 'pre-wrap';
        } else {
            content.innerHTML = renderMarkdown(text);
        }

        messageDiv.appendChild(label);
        messageDiv.appendChild(content);

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

            const contentDiv = document.createElement('div');
            contentDiv.className = 'debug-doc-content';
            const displayContent = doc.content.length > 300 ?
                doc.content.substring(0, 300) + '...' : doc.content;
            contentDiv.textContent = displayContent;

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

    if (syntaxCheckBtn) {
        syntaxCheckBtn.addEventListener('click', () => {
            if (isLoading) return;
            statusElement.textContent = '正在检查语法...';
            vscode.postMessage({ type: 'syntaxCheck' });
        });
    }

    if (learningPathBtn) {
        learningPathBtn.addEventListener('click', () => {
            if (isLoading) return;
            statusElement.textContent = '正在生成学习路径...';
            vscode.postMessage({ type: 'learningPath' });
        });
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
            case 'aiResponse':
                addMessage(message.response, false, message.isError, message.retrievalDetails, message.featureType);
                statusElement.textContent = 'Response received';
                break;
            case 'selectedCode':
                displaySelectedCode(message.code, message.fileName, message.language);
                break;
            case 'loading':
                setLoading(message.isLoading);
                break;
            case 'triggerFeature':
                if (message.featureType === 'syntaxCheck' && syntaxCheckBtn) {
                    syntaxCheckBtn.click();
                } else if (message.featureType === 'learningPath' && learningPathBtn) {
                    learningPathBtn.click();
                }
                break;
        }
    });

    addMessage('Hello! I am your AI coding assistant. Ask me anything!', false);
})();
