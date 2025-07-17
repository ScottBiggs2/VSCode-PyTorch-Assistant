import * as vscode from 'vscode';
import { PythonShell } from 'python-shell';
import * as path from 'path';
import { TextDecoder } from 'util';
import * as Diff from 'diff';

// A more structured message type for our conversation
export interface ChatMessage {
    role: 'user' | 'assistant';
    type: 'user_input' | 'explanation' | 'replace_file' | 'error' | 'loading' | 'explanation_with_changes' | 'multi_file_change';
    content?: string; // For simple message types
    isLoading?: boolean;
    explanation?: string; // For explanation_with_changes
    code?: string; // For explanation_with_changes and replace_file
    diff?: string; // For rendering diffs
    changes?: {
        filePath: string;
        newCode: string;
        diff: string;
    }[];
}

export class PyTorchChatProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'pytorch-assistant.chat';
    private _view?: vscode.WebviewView;
    private _conversation: ChatMessage[] = [];
    private _pendingResponse = false;
    private _contextFiles: vscode.Uri[] = [];
    private _currentModel: string = 'local'; // Default model

    constructor(private readonly _context: vscode.ExtensionContext) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        this._currentModel = this._context.workspaceState.get('selectedModel', 'local');

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'sendMessage':
                    this._currentModel = data.model;
                    await this._handleUserMessage(data.message, this._currentModel); //Use _currentModel instead
                     break;
                 case 'modelSelected':
                     this._currentModel = data.model;
                    break;
                case 'addFile':
                    await this._handleAddFile();
                    break;
                case 'removeFile':
                    this._handleRemoveFile(data.uri);
                    break;
                case 'clearChat':
                    this._conversation = [];
                    this._updateWebview();
                    break;
                case 'insertCode':
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        editor.edit(editBuilder => {
                            editBuilder.insert(editor.selection.active, data.code);
                        });
                    }
                    break;
                case 'applyChanges': // New handler for full file replacements
                    const activeEditor = vscode.window.activeTextEditor;
                    if (activeEditor) {
                        const document = activeEditor.document;
                        const fullRange = new vscode.Range(
                            document.positionAt(0),
                            document.positionAt(document.getText().length)
                        );
                        activeEditor.edit(editBuilder => editBuilder.replace(fullRange, data.code));
                    }
                    break;
                case 'applyMultiFileChanges':
                    try {
                        const changesToApply = JSON.parse(data.changes);
                        this._handleApplyMultiFileChanges(changesToApply);
                    } catch (e) { console.error("Failed to parse multi-file changes:", e); }
                    break;
                case 'modelSelected':
                    this._currentModel = data.model;
                    await this._context.workspaceState.update('selectedModel', data.model);
                     break;
            }
        });
    }

    private async _handleAddFile() {
        const files = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Add to Context',
            title: 'Select Files for AI Context'
        });

        if (files) {
            files.forEach(fileUri => {
                // Avoid adding duplicates
                if (!this._contextFiles.some(existingUri => existingUri.toString() === fileUri.toString())) {
                    this._contextFiles.push(fileUri);
                }
            });
            this._updateWebview();
        }
    }

    private _handleRemoveFile(uriString: string) {
        this._contextFiles = this._contextFiles.filter(uri => uri.toString() !== uriString);
        this._updateWebview();
    }

    private async _handleUserMessage(message: string, model: string) {
        if (!this._view) return;
        if (this._pendingResponse) return;
        
        const thinkingMessages = [
            'Thinking...',
            'One moment...',
            'Consulting the PyTorch docs...',
            'Analyzing your code...',
            'Let me check that...'
        ];
        const randomMessage = thinkingMessages[Math.floor(Math.random() * thinkingMessages.length)];

        this._pendingResponse = true;
        this._conversation.push({ role: 'user', type: 'user_input', content: message });
        this._conversation.push({ role: 'assistant', type: 'loading', content: randomMessage, isLoading: true });
        this._updateWebview();

        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'python') {
                this._conversation.pop(); // remove loading message
                this._conversation.push({ 
                    role: 'assistant', 
                    type: 'error',
                    content: '⚠️ Please open a Python file to use the chat.'
                });
                this._pendingResponse = false;
                this._updateWebview();
                return;
            }

            const activeDocument = editor.document;

            // Aggregate all context files, starting with the active one
            const allFiles = [{
                filePath: activeDocument.uri.fsPath,
                content: activeDocument.getText()
            }];

            for (const fileUri of this._contextFiles) {
                try {
                    const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                    const content = new TextDecoder().decode(contentBytes);
                    allFiles.push({ filePath: fileUri.fsPath, content });
                } catch (e) {
                    vscode.window.showWarningMessage(`Could not read file: ${fileUri.fsPath}`);
                }
            }

            const jsonResponse = await this._getLLMResponse(message, allFiles, model);
            const responseObject = JSON.parse(jsonResponse);

            // Replace loading message with actual response
            const lastMessage = this._conversation[this._conversation.length - 1];
            if (lastMessage && lastMessage.isLoading) {
                this._conversation.pop();
            }
            
            let messageToPush: ChatMessage;

            if (responseObject.type === 'multi_file_change') {
                const changesWithDiffs = [];
                for (const change of responseObject.changes) {
                    const originalFile = allFiles.find(f => f.filePath === change.filePath);
                    const originalContent = originalFile ? originalFile.content : '';

                    if (!originalFile) {
                        vscode.window.showWarningMessage(`Could not find original content for ${change.filePath} to compute diff.`);
                    }

                    const diff = this._computeDiff(originalContent, change.newContent);
                    changesWithDiffs.push({ filePath: change.filePath, newCode: change.newContent, diff });
                }
                messageToPush = {
                    role: 'assistant',
                    type: 'multi_file_change',
                    explanation: responseObject.explanation,
                    changes: changesWithDiffs
                };
            } else if (responseObject.type === 'explanation_with_changes') {
                const newCode = responseObject.code;
                const originalCode = editor.document.getText();
                const diff = this._computeDiff(originalCode, newCode);
                messageToPush = {
                    role: 'assistant',
                    type: 'explanation_with_changes',
                    explanation: responseObject.explanation,
                    code: newCode,
                    diff: diff
                };
            } else if (responseObject.type === 'replace_file') {
                const newCode = responseObject.content;
                const originalCode = editor.document.getText();
                const diff = this._computeDiff(originalCode, newCode);
                messageToPush = {
                    role: 'assistant',
                    type: 'replace_file',
                    code: newCode,
                    diff: diff
                };
            } else {
                messageToPush = { role: 'assistant', type: responseObject.type, content: responseObject.content };
            }
            this._conversation.push(messageToPush);

        } catch (error) {
            this._conversation.pop(); // remove loading message
            this._conversation.push({ 
                role: 'assistant', 
                type: 'error',
                content: `❌ An error occurred: ${(error as Error).message}`
            });
        } finally {
            this._pendingResponse = false;
            this._updateWebview();
        }
    }

    /**
     * Applies a series of file changes to the workspace using a single atomic operation.
     * This function creates a WorkspaceEdit, which is a container for multiple edits
     * across different files. By using applyEdit, we ensure that either all changes
     * are applied, or none are, preventing the workspace from being left in a
     * partially modified state.
     * @param changes An array of objects, each with a filePath and the newCode for that file.
     */
    private async _handleApplyMultiFileChanges(changes: { filePath: string, newCode: string }[]) {
        if (!changes || changes.length === 0) {
            return;
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const change of changes) {
            const fileUri = vscode.Uri.file(change.filePath);
            // To replace the entire content, we create a range that spans the whole document.
            // A massive range from line 0 to a very large line number ensures we cover everything.
            // VS Code's applyEdit will correctly handle this to replace the entire file content.
            const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(999999, 999999));
            workspaceEdit.replace(fileUri, fullRange, change.newCode);
        }

        const success = await vscode.workspace.applyEdit(workspaceEdit);
        if (success) {
            vscode.window.showInformationMessage(`Applied changes to ${changes.length} files.`);
        } else {
            vscode.window.showErrorMessage('Failed to apply multi-file changes.');
        }
    }


    private async _getLLMResponse(message: string, files: {filePath: string, content: string}[], model: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(this._context.extensionPath, 'src', 'pytorch_linter.py');

            const pyshell = new PythonShell(scriptPath, {
                mode: 'json', // Use JSON for sending/receiving data
                pythonOptions: ['-u'],
                pythonPath: 'python3'
            });

            // Send the user's message and all file contexts to the Python script
            pyshell.send({ command: 'chat', prompt: message, files: files, model: model });

            let response: any;
            pyshell.on('message', (message: any) => {
                // The final JSON response from Python
                response = message;
            });

            pyshell.end((err) => {
                if (err) {
                    console.error(`Python script error: ${err.stack || err.message}`);
                    reject(err);
                } else {
                    // The Python script now returns a single JSON string
                    resolve(JSON.stringify(response));
                }
            });
        });
    }

    private _computeDiff(original: string, modified: string): string {
        const diff = Diff.createPatch('file', original, modified, '', '', { context: 3 });
        // We don't need the full patch header, just the diff lines.
        const lines = diff.split('\n').slice(4); // Skip header lines
        return lines.join('\n');
    }

    private _renderDiff(diff: string): string {
        const escapeHtml = (unsafe: string) => unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        return diff.split('\n').map(line => {
            const escapedLine = escapeHtml(line);
            if (line.startsWith('+')) return `<span class="diff-line-added">${escapedLine}</span>`;
            if (line.startsWith('-')) return `<span class="diff-line-removed">${escapedLine}</span>`;
            if (line.startsWith('@@')) return `<span class="diff-line-hunk">${escapedLine}</span>`;
            return `<span class="diff-line-context">${escapedLine}</span>`;
        }).join('');
    }

    private _updateWebview() {
        if (this._view) {
            this._view.webview.html = this.getHtmlForWebview(this._view.webview);
        }
    }

    public getHtmlForWebview(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'src', 'media', 'chat.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'src', 'media', 'chat.js')
        );

        const escapeHtml = (unsafe: string) =>
            unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");

        const messages = this._conversation.map((msg: ChatMessage) => {
            const roleClass = msg.role === 'user' ? 'user-message' : 'assistant-message';
            const avatar = msg.role === 'user' ? '👨‍💻' : '🤖';
            
            if (msg.type === 'loading') {
                return `<div class="message assistant-message loading">
                    <div class="avatar">🤖</div>
                    <div class="content">
                        ${escapeHtml(msg.content ?? '')}
                        <div class="loading-indicator"><span></span><span></span><span></span></div>
                    </div>
                </div>`;	
            }

            // Helper for rendering markdown content with snippets
            const renderExplanation = (content: string) => {
                const codeBlockRegex = /(```(?:python\n)?[\s\S]*?```)/g;
                const parts = content.split(codeBlockRegex);

                return parts.map(part => {
                    const codeMatch = part.match(/```(python\n)?([\s\S]*?)```/);
                    if (codeMatch && codeMatch[2]) {
                        const code = codeMatch[2].trim();
                        return `<div class="code-block">
                                    <pre><code>${escapeHtml(code)}</code></pre>
                                    <button class="insert-code-btn">Insert Snippet</button>
                                </div>`;
                    }
                    // A proper implementation would use a markdown renderer here.
                    // For now, just escaping and replacing newlines with <br> for basic formatting.
                    return escapeHtml(part).replace(/\n/g, '<br>');
                }).join('');
            };

            let contentHtml = '';
            // Ensure msg.content is not undefined before using it
            const content = msg.content ?? '';

            switch (msg.type) {
                case 'user_input':
                    contentHtml = escapeHtml(content);
                    break;
                case 'error':
                    contentHtml = `<div class="error-message">${escapeHtml(content)}</div>`;
                    break;
                case 'replace_file':
                    contentHtml = `<div class="code-block diff-file">
                                    <div class="code-block-header">Suggested Changes (Diff)</div>
                                    <pre class="diff-view"><code>${this._renderDiff(msg.diff ?? '')}</code></pre>
                                    <button class="apply-changes-btn" data-code="${escapeHtml(msg.code ?? '')}">Apply Changes</button>
                                </div>`;
                    break;
                case 'explanation':
                    contentHtml = renderExplanation(content);
                    break;
                case 'explanation_with_changes':
                    const explanationPart = renderExplanation(msg.explanation ?? '');
                    const changesPart = `<div class="code-block diff-file">
                                            <div class="code-block-header">Suggested Changes (Diff)</div>
                                            <pre class="diff-view"><code>${this._renderDiff(msg.diff ?? '')}</code></pre>
                                            <button class="apply-changes-btn" data-code="${escapeHtml(msg.code ?? '')}">Apply Changes</button>
                                        </div>`;
                    contentHtml = explanationPart + changesPart;
                    break;
                case 'multi_file_change':
                    const explanationPartMulti = renderExplanation(msg.explanation ?? '');
                    const changesPartMulti = (msg.changes ?? []).map(change => `
                        <div class="code-block diff-file">
                            <div class="code-block-header">
                                <span class="codicon codicon-file"></span>
                                ${escapeHtml(path.basename(change.filePath))}
                            </div>
                            <pre class="diff-view"><code>${this._renderDiff(change.diff ?? '')}</code></pre>
                        </div>
                    `).join('');
                    
                    const serializableChanges = msg.changes?.map(c => ({ filePath: c.filePath, newCode: c.newCode })) ?? [];
                    const applyAllButton = `<button class="apply-all-changes-btn" data-changes='${escapeHtml(JSON.stringify(serializableChanges))}'>Apply All Changes</button>`;
                    contentHtml = explanationPartMulti + changesPartMulti + applyAllButton;
                    break;
                default:
                    contentHtml = escapeHtml(content);
            }

            return `<div class="message ${roleClass}">
                <div class="avatar">${avatar}</div>
                <div class="content">${contentHtml}</div>
            </div>`;
        }).join('');

        const isDisabled = this._pendingResponse ? 'disabled' : '';

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>PyTorch Assistant</title>
            <link rel="stylesheet" href="${styleUri}">
                        <style>
                .context-files-container {
                    padding: 8px;                    
                    margin-bottom: 5px;
                    border-bottom: 1px solid var(--vscode-divider-background);
                }
                #model-select {
                    width: 100%;
                    margin-bottom: 5px;
                }
                .context-header {
                    display: flex;
                    width: 100%;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 5px;
                }
                .context-header h4 {
                    margin: 0;
                    font-size: 0.9em;
                    font-weight: 600;
                    text-transform: uppercase;
                    opacity: 0.7;
                }
                .code-block-header .codicon {
                    margin-right: 5px;
                }
                .add-file-button {
                    background: none;
                    border: none;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    font-size: 1.5em;
                    line-height: 1;
                }
                #context-files-list {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                    max-height: 100px;
                    overflow-y: auto;
                }
                #context-files-list li {
                    display: flex;
                    align-items: center;
                    margin-bottom: 4px;
                    font-size: 0.9em;
                }
                .file-name {
                    margin-left: 5px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .remove-context-btn {
                    background: none;
                    border: none;
                    cursor: pointer;
                    color: var(--vscode-foreground);
                    margin-left: auto;
                    padding: 0 5px;
                    opacity: 0.6;
                }
                .remove-context-btn:hover {
                    opacity: 1;
                }
                
            </style>
        </head>
        <body>
            <div class="chat-container">
                <div class="context-files-container">
                <div class="context-header">
                    <h4>Context Files</h4>
                    <button id="add-file-btn" class="add-file-button" title="Add files to context">+</button>
                 </div>
                <div>
                <select id="model-select">
                        <option value="local">Local Qwen3 & DeepSeek-R1</option>
                        <option value="claude">Claude Sonnet 4</option>
                        <option value="codestral">Codestral</option>
                </select>                
                </div>
                    <ul id="context-files-list">
                        ${this._contextFiles.map(uri => `
                            <li>
                                <span class="codicon codicon-file"></span>
                                <span class="file-name" title="${uri.fsPath}">${path.basename(uri.fsPath)}</span>
                                <button class="remove-context-btn" data-uri="${uri.toString()}">×</button>
                            </li>`).join('')}
                    </ul>
                </div>
                <div class="messages">${messages}</div>
                <div class="input-container">
                    <textarea id="message-input" placeholder="Ask for PyTorch help..." ${isDisabled}></textarea>
                    <button id="send-button" ${isDisabled}>Send</button>    
                    <button id="clear-button" ${isDisabled}>Clear</button>
                </div>
                    </div>
            </div>
            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    const messageInput = document.getElementById('message-input');
                    const sendButton = document.getElementById('send-button');
                    const clearButton = document.getElementById('clear-button');
                    const messagesContainer = document.querySelector('.messages');
                    document.getElementById('model-select').value = '${this._currentModel}';
                    const modelSelect = document.getElementById('model-select');

                    function sendMessage() {
                        if (messageInput.value.trim()) {
                            const selectedModel = modelSelect.value;
                            vscode.postMessage({
                                type: 'sendMessage',
                                message: messageInput.value,
                                model: selectedModel
                            });
                            messageInput.value = '';
                        }
                    }

                    modelSelect.addEventListener('change', () => {
                        vscode.postMessage({ type: 'modelSelected', model: modelSelect.value });
                    });

                    sendButton.addEventListener('click', sendMessage);

                    messageInput.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            sendMessage();
                        }
                    });

                    clearButton.addEventListener('click', () => {
                        vscode.postMessage({ type: 'clearChat' });
                    });

                    // Use event delegation for dynamically added buttons
                    document.body.addEventListener('click', event => {
                        const target = event.target;

                        if (target.classList.contains('insert-code-btn')) {
                            const code = target.closest('.code-block').querySelector('code').textContent;
                            vscode.postMessage({ type: 'insertCode', code: code });
                        }

                        if (target.classList.contains('apply-changes-btn')) {
                            const code = target.dataset.code;
                            vscode.postMessage({ type: 'applyChanges', code: code });
                        }

                        if (target.classList.contains('apply-all-changes-btn')) {
                            const changes = target.dataset.changes;
                            vscode.postMessage({ type: 'applyMultiFileChanges', changes: changes });
                        }

                        if (target.id === 'add-file-btn') {
                             vscode.postMessage({ type: 'addFile' });
                        }

                        if (target.classList.contains('remove-context-btn')) {
                            const uri = target.dataset.uri;
                            vscode.postMessage({ type: 'removeFile', uri: uri });
                        }
                    });
                }());
            </script>
        </body>
        </html>`;
    }
}