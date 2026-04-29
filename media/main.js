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

    function addMessage(text, isUser = false, isError = false) {
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
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
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
                addMessage(message.response, false, message.isError);
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