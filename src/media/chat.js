(function() {
    const vscode = acquireVsCodeApi();

    const modelSelect = document.getElementById('model-select'); // Get the dropdown
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const clearButton = document.getElementById('clear-button');
    const messagesContainer = document.querySelector('.messages');

    function sendMessage() {
        // Don't send if disabled or empty
        if (sendButton.disabled || messageInput.value.trim().length === 0) {
            return;
        }
        
        const message = messageInput.value.trim();
        const selectedModel = modelSelect.value; // Get the selected model
        vscode.postMessage({
            type: 'sendMessage',
            message: message,
            model: selectedModel // Include the selected model in the message
        });
    }

    sendButton.addEventListener('click', sendMessage);

    clearButton.addEventListener('click', () => {
        if (clearButton.disabled) return;
        vscode.postMessage({ type: 'clearChat' });
    });

    messageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    // Use event delegation for insert code buttons
    messagesContainer.addEventListener('click', event => {
        const target = event.target;
        if (target.classList.contains('insert-code-btn')) {
            const codeBlock = target.previousElementSibling;
            if (codeBlock && codeBlock.tagName === 'PRE') {
                const code = codeBlock.textContent;
                vscode.postMessage({ type: 'insertCode', code: code });
            }
        } else if (target.classList.contains('apply-changes-btn')) {
            // Get the full code from the data-code attribute
            const code = target.dataset.code;
            if (code) {
                vscode.postMessage({ type: 'applyChanges', code: code });
            }
        }
    });

    // Auto-scroll to bottom when new messages arrive
    const observer = new MutationObserver(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
    observer.observe(messagesContainer, { childList: true });
})();
