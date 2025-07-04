(function() {
    const vscode = acquireVsCodeApi();
    
    // Elements
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const clearButton = document.getElementById('clear-button');
    const messagesContainer = document.querySelector('.messages');
    
    // Send message handler
    sendButton.addEventListener('click', () => {
        const message = messageInput.value.trim();
        if (message) {
            vscode.postMessage({
                type: 'sendMessage',
                message: message
            });
            messageInput.value = '';
        }
    });
    
    // Clear chat handler
    clearButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'clearChat' });
    });
    
    // Enter key to send
    messageInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendButton.click();
        }
    });
    
    // Insert code handler
    document.addEventListener('click', event => {
        if (event.target.tagName === 'BUTTON' && event.target.dataset.index !== undefined) {
            const codeBlock = event.target.nextElementSibling.textContent;
            vscode.postMessage({
                type: 'insertCode',
                code: codeBlock
            });
        }
    });
    
    // Auto-scroll to bottom when new messages arrive
    const observer = new MutationObserver(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
    
    observer.observe(messagesContainer, { childList: true });
})();