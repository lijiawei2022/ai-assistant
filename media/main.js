(function() {
    const vscode = acquireVsCodeApi();

    const chatMessages = document.getElementById('chat-messages');
    const questionInput = document.getElementById('question-input');
    const askButton = document.getElementById('ask-button');
    const clearButton = document.getElementById('clear-button');
    const clearRecordsBtn = document.getElementById('clear-records-btn');
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
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderMarkdown(text) {
        const tokens = [];
        let src = text;

        src = src.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
            const idx = tokens.length;
            tokens.push('<div class="code-wrapper"><div class="code-header"><span class="code-lang">' +
                (lang || 'code') + '</span><button class="copy-btn" onclick="copyCode(this)">复制</button></div><pre class="code-block"><code>' +
                escapeHtml(code.trimEnd()) + '</code></pre></div>');
            return '\x00TOK' + idx + '\x00';
        });

        src = src.replace(/`([^`\n]+)`/g, function(match, code) {
            const idx = tokens.length;
            tokens.push('<code class="inline-code">' + escapeHtml(code) + '</code>');
            return '\x00TOK' + idx + '\x00';
        });

        src = escapeHtml(src);

        src = src.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
        src = src.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        src = src.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        src = src.replace(/^# (.+)$/gm, '<h2>$1</h2>');

        src = src.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        src = src.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

        src = src.replace(/^(\s*)- (.+)$/gm, function(m, indent, content) {
            return indent + '<li>' + content + '</li>';
        });

        src = src.replace(/^(\s*)\d+\. (.+)$/gm, function(m, indent, content) {
            return indent + '<li>' + content + '</li>';
        });

        src = src.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

        src = src.replace(/\n{2,}/g, '</p><p>');
        src = src.replace(/\n/g, '<br>');
        src = '<p>' + src + '</p>';

        src = src.replace(/<p>\s*<\/p>/g, '');
        src = src.replace(/<p>\s*(<h[2-5]>)/g, '$1');
        src = src.replace(/(<\/h[2-5]>)\s*<\/p>/g, '$1');
        src = src.replace(/<p>\s*(<ul>)/g, '$1');
        src = src.replace(/(<\/ul>)\s*<\/p>/g, '$1');

        for (let i = 0; i < tokens.length; i++) {
            src = src.replace('<p>\x00TOK' + i + '\x00</p>', tokens[i]);
            src = src.replace('\x00TOK' + i + '\x00', tokens[i]);
        }

        return src;
    }

    window.copyCode = function(btn) {
        const codeBlock = btn.closest('.code-wrapper').querySelector('code');
        const text = codeBlock.textContent;
        navigator.clipboard.writeText(text).then(() => {
            btn.textContent = '已复制';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = '复制';
                btn.classList.remove('copied');
            }, 1500);
        });
    };

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
                <div class="message-avatar ai-avatar">AI</div>
                <div class="message-body">
                    <div class="message-content">
                        <div class="typing-indicator">
                            <span></span><span></span><span></span>
                        </div>
                    </div>
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
        contextInfo.textContent = `${fileName} · ${language} · ${code.split('\n').length} lines`;
        codeContext.style.display = 'block';
        statusElement.textContent = 'Code context loaded';
    }

    function addMessage(text, isUser, isError, retrievalDetails, featureType, llmMessages, kgMatchedNodes) {
        const messageDiv = document.createElement('div');
        let className = 'message ' + (isUser ? 'user-message' : 'ai-message');
        if (isError) className += ' error-message';
        if (featureType === 'syntaxCheck') className += ' feature-syntax';
        if (featureType === 'learningPath') className += ' feature-learning';
        messageDiv.className = className;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar ' + (isUser ? 'user-avatar' : 'ai-avatar');
        if (isUser) {
            avatar.textContent = 'U';
        } else if (featureType === 'syntaxCheck') {
            avatar.textContent = '🔍';
        } else if (featureType === 'learningPath') {
            avatar.textContent = '📚';
        } else {
            avatar.textContent = 'AI';
        }

        const body = document.createElement('div');
        body.className = 'message-body';

        const content = document.createElement('div');
        content.className = 'message-content markdown-body';

        if (isUser || isError) {
            content.textContent = text;
            content.style.whiteSpace = 'pre-wrap';
        } else {
            content.innerHTML = renderMarkdown(text);
        }

        body.appendChild(content);

        if (!isUser && kgMatchedNodes && kgMatchedNodes.length > 0) {
            const kgPanel = createKGPanel(kgMatchedNodes);
            body.appendChild(kgPanel);
        }

        if (!isUser && retrievalDetails && retrievalDetails.length > 0) {
            const debugPanel = createDebugPanel(retrievalDetails);
            body.appendChild(debugPanel);
        }

        if (!isUser && llmMessages && llmMessages.length > 0) {
            const llmPanel = createLlmMessagesPanel(llmMessages);
            body.appendChild(llmPanel);
        }

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(body);

        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function createDebugPanel(details) {
        const panel = document.createElement('details');
        panel.className = 'debug-panel';
        panel.open = false;

        const summary = document.createElement('summary');
        summary.className = 'debug-summary';
        summary.textContent = `检索详情 (${details.length} 个文档块)`;

        const content = document.createElement('div');
        content.className = 'debug-content';

        details.forEach((doc) => {
            const docDiv = document.createElement('div');
            docDiv.className = 'debug-doc';

            const headerDiv = document.createElement('div');
            headerDiv.className = 'debug-doc-header';

            const fileSpan = document.createElement('span');
            fileSpan.className = 'debug-file';
            fileSpan.textContent = doc.fileName;

            const scoresSpan = document.createElement('span');
            scoresSpan.className = 'debug-scores';
            let scoreText = `RRF ${doc.rrfScore.toFixed(4)}`;
            if (doc.vectorScore !== undefined) scoreText += ` · Vec ${doc.vectorScore.toFixed(4)}`;
            if (doc.keywordScore !== undefined) scoreText += ` · KW ${doc.keywordScore.toFixed(2)}`;
            scoresSpan.textContent = scoreText;

            headerDiv.appendChild(fileSpan);
            headerDiv.appendChild(scoresSpan);

            const contentDiv = document.createElement('div');
            contentDiv.className = 'debug-doc-content';
            contentDiv.textContent = doc.content;

            docDiv.appendChild(headerDiv);
            docDiv.appendChild(contentDiv);
            content.appendChild(docDiv);
        });

        panel.appendChild(summary);
        panel.appendChild(content);
        return panel;
    }

    function createKGPanel(matchedNodes) {
        const panel = document.createElement('details');
        panel.className = 'debug-panel kg-panel';
        panel.open = false;

        const summary = document.createElement('summary');
        summary.className = 'debug-summary';
        summary.textContent = `知识图谱匹配 (${matchedNodes.length} 个节点)`;

        const content = document.createElement('div');
        content.className = 'debug-content';

        const typeLabels = { knowledge: '知识点', error: '错误类型', solution: '解决方案', symptom: '症状', tool: '工具' };
        const typeColors = { knowledge: '#4fc3f7', error: '#ef5350', solution: '#66bb6a', symptom: '#ffa726', tool: '#ab47bc' };

        matchedNodes.forEach((nodeInfo) => {
            const nodeDiv = document.createElement('div');
            nodeDiv.className = 'kg-node';

            const badge = document.createElement('span');
            badge.className = 'kg-node-badge';
            const nodeType = nodeInfo.type || 'unknown';
            badge.textContent = typeLabels[nodeType] || nodeType;
            badge.style.backgroundColor = typeColors[nodeType] || '#888';
            badge.style.color = '#fff';
            badge.style.padding = '1px 6px';
            badge.style.borderRadius = '3px';
            badge.style.fontSize = '11px';
            badge.style.marginRight = '6px';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = nodeInfo.name || nodeInfo.id;

            nodeDiv.appendChild(badge);
            nodeDiv.appendChild(nameSpan);
            content.appendChild(nodeDiv);
        });

        panel.appendChild(summary);
        panel.appendChild(content);
        return panel;
    }

    function createLlmMessagesPanel(messages) {
        const panel = document.createElement('details');
        panel.className = 'debug-panel llm-messages-panel';
        panel.open = false;

        const summary = document.createElement('summary');
        summary.className = 'debug-summary';
        summary.textContent = '发送给大模型的消息 (' + messages.length + ' 条)';

        const content = document.createElement('div');
        content.className = 'debug-content';

        messages.forEach(function(msg) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'llm-msg';

            const roleLabel = document.createElement('div');
            roleLabel.className = 'llm-msg-role';
            if (msg.role === 'system') {
                roleLabel.textContent = 'SYSTEM';
                roleLabel.classList.add('role-system');
            } else if (msg.role === 'user') {
                roleLabel.textContent = 'USER';
                roleLabel.classList.add('role-user');
            } else {
                roleLabel.textContent = 'ASSISTANT';
                roleLabel.classList.add('role-assistant');
            }

            const msgContent = document.createElement('pre');
            msgContent.className = 'llm-msg-content';
            msgContent.textContent = msg.content;

            msgDiv.appendChild(roleLabel);
            msgDiv.appendChild(msgContent);
            content.appendChild(msgDiv);
        });

        panel.appendChild(summary);
        panel.appendChild(content);
        return panel;
    }

    function clearChat() {
        chatMessages.innerHTML = '';
        statusElement.textContent = '本次会话已清空';
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
        vscode.postMessage({ type: 'clearChat' });
    });
    if (clearRecordsBtn) {
        clearRecordsBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearRecords' });
        });
    }
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
                addMessage(message.response, false, message.isError, message.retrievalDetails, message.featureType, message.llmMessages, message.kgMatchedNodes);
                statusElement.textContent = 'Response received';
                break;
            case 'selectedCode':
                displaySelectedCode(message.code, message.fileName, message.language);
                break;
            case 'loading':
                setLoading(message.isLoading);
                break;
            case 'clearChat':
                clearChat();
                break;
            case 'recordsCleared':
                statusElement.textContent = '学习记录已清空';
                break;
            case 'userAction':
                addMessage(message.text, true);
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

    addMessage('你好！我是AI编程助教，专注于C语言程序设计。你可以问我编程问题，或者使用下方快捷按钮进行语法检查和获取学习路径推荐。', false);
})();
