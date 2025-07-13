import * as vscode from 'vscode';
import { PythonShell } from 'python-shell';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as Diff from 'diff';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('PyTorch Helper');

    // ======================
    // 1. Suggestion Decoration (the lightbulb)
    // ======================
    const suggestionDecoration = vscode.window.createTextEditorDecorationType({
        gutterIconPath: context.asAbsolutePath('media/lightbulb.svg'),
        gutterIconSize: 'contain',
        overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right
    });

    // ======================
    // 2. Code Suggestion Interface
    // ======================
    interface CodeSuggestion {
        range: vscode.Range;
        newText: string;
        message: string;
    }

    // ======================
    // 3. Parse LLM Output
    // ======================
    function parseSuggestion(output: string): CodeSuggestion | null {
        const match = output.match(/Line (\d+)(?:-(\d+))?: (.*?):\s*(.*)/s);
        if (!match) return null;

        const startLine = parseInt(match[1]) - 1;
        const endLine = match[2] ? parseInt(match[2]) - 1 : startLine;
        
        return {
            range: new vscode.Range(startLine, 0, endLine, 1000),
            newText: match[4].trim(),
            message: match[3].trim()
        };
    }

    // ======================
    // 4. Display Inline Suggestions
    // ======================
    function showInlineSuggestions(editor: vscode.TextEditor, suggestions: CodeSuggestion[]) {
        const decorations: vscode.DecorationOptions[] = [];

        suggestions.forEach((suggestion) => {
            decorations.push({
                range: suggestion.range,
                hoverMessage: suggestion.message,
                renderOptions: {
                    after: {
                        contentText: `💡 ${suggestion.newText}`,
                        fontStyle: 'italic',
                        color: new vscode.ThemeColor('editorCodeLens.foreground')
                    }
                }
            });
        });

        editor.setDecorations(suggestionDecoration, decorations);
    }

    // ======================
    // 6. Enhanced Linter Command
    // ======================
    const linterDisposable = vscode.commands.registerCommand('pytorch-helper.runPython', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor!');
            return;
        }

        editor.document.save().then(() => {
            const scriptPath = path.join(context.extensionPath, 'src', 'pytorch_linter.py');
            
            outputChannel.clear();
            outputChannel.appendLine(`Analyzing: ${path.basename(editor.document.fileName)}`);
            
            const pyshell = new PythonShell(scriptPath, {
                args: [editor.document.fileName],
                pythonOptions: ['-u'],
                pythonPath: 'python3'
            });

            const suggestions: CodeSuggestion[] = [];
            
            pyshell.on('message', (message: string) => {
                outputChannel.appendLine(message);
                const suggestion = parseSuggestion(message);
                if (suggestion) {
                    suggestions.push(suggestion);
                }
            });

            pyshell.end((err) => {
                if (err) {
                    outputChannel.appendLine(`ERROR: ${err.message}`);
                }
                if (suggestions.length > 0) {
                    showInlineSuggestions(editor, suggestions);
                }
                outputChannel.show();
            });
        });
    });

    // ======================
    // 7. Quick Fix Command
    // ======================
    const quickFixDisposable = vscode.commands.registerCommand(
        'pytorch-helper.quickFix',
        async (uri: vscode.Uri, lineNum: number, fixType: string) => {
            const editor = await vscode.window.showTextDocument(uri);
            const line = editor.document.lineAt(lineNum);
            let newText = line.text;

            switch (fixType) {
                case 'device':
                    newText = line.text.replace(
                        /(\w+\s*=\s*(torch\.|)Tensor\([^)]*\))(?!\s*\.to\(device\))/, 
                        '$1.to(device)'
                    );
                    break;
                    
                case 'retain':
                    newText = line.text.replace(
                        /backward\(([^)]*)\)/, 
                        'backward($1, retain_graph=True)'
                    );
                    break;
            }

            if (newText !== line.text) {
                editor.edit(editBuilder => {
                    editBuilder.replace(line.range, newText);
                }).then(success => {
                    if (success) {
                        outputChannel.appendLine(`QuickFix applied at line ${lineNum + 1}: ${fixType}`);
                    }
                });
            }
        }
    );

    // ======================
    // 8. Enhanced CodeLens Provider
    // ======================
    class PyTorchCodeLensProvider implements vscode.CodeLensProvider {
        async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
            const lenses: vscode.CodeLens[] = [];
            const config = vscode.workspace.getConfiguration('pytorchHelper');
            
            if (!config.get<boolean>('enableCodeLens', true)) {
                return lenses;
            }

            for (let i = 0; i < document.lineCount; i++) {
                const line = document.lineAt(i);
                
                // Better tensor detection
                if (line.text.includes('Tensor(') && 
                    !line.text.includes('.to(device)') &&
                    !line.text.includes('device=')) {
                    lenses.push(new vscode.CodeLens(line.range, {
                        title: "⚡ Add .to(device)",
                        command: 'pytorch-helper.quickFix',
                        arguments: [document.uri, i, 'device']
                    }));
                }
                
                // Better backward detection
                if (line.text.includes('backward(') && 
                    !line.text.includes('retain_graph') &&
                    !line.text.includes('retain_graph=')) {
                    lenses.push(new vscode.CodeLens(line.range, {
                        title: "⚡ Add retain_graph",
                        command: 'pytorch-helper.quickFix',
                        arguments: [document.uri, i, 'retain']
                    }));
                }
            }
            return lenses;
        }
    }

    const codeLensProvider = new PyTorchCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('python', codeLensProvider)
    );

	// ======================
	// 9. Chat Panel Implementation
	// ======================
	// A more structured message type for our conversation
	interface ChatMessage {
		role: 'user' | 'assistant';
		type: 'user_input' | 'explanation' | 'replace_file' | 'error' | 'loading' | 'explanation_with_changes';
		content?: string; // For simple message types
		isLoading?: boolean;
		explanation?: string; // For explanation_with_changes
		code?: string; // For explanation_with_changes and replace_file
		diff?: string; // For rendering diffs
	}

	class PyTorchChatProvider implements vscode.WebviewViewProvider {
		public static readonly viewType = 'pytorch-assistant.chat';
		private _view?: vscode.WebviewView;
		private _conversation: ChatMessage[] = [];
		private _pendingResponse = false;

		constructor(private readonly _context: vscode.ExtensionContext) {}

		public resolveWebviewView(
			webviewView: vscode.WebviewView,
			context: vscode.WebviewViewResolveContext,
			_token: vscode.CancellationToken
		) {
			this._view = webviewView;

			webviewView.webview.options = {
				enableScripts: true,
				localResourceRoots: [this._context.extensionUri]
			};

			webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

			webviewView.webview.onDidReceiveMessage(async data => {
				switch (data.type) {
					case 'sendMessage':
						await this._handleUserMessage(data.message);
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
				}
			});
		}

		private async _handleUserMessage(message: string) {
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

				const code = editor.document.getText();
				const jsonResponse = await this._getLLMResponse(message, code);
				const responseObject = JSON.parse(jsonResponse);

				// Replace loading message with actual response
				const lastMessage = this._conversation[this._conversation.length - 1];
				if (lastMessage && lastMessage.isLoading) {
					this._conversation.pop();
				}
				
				const originalCode = editor.document.getText();
				let newCode: string | undefined;
				if (responseObject.type === 'replace_file') {
					newCode = responseObject.content;
				} else if (responseObject.type === 'explanation_with_changes') {
					newCode = responseObject.code;
				}

				let messageToPush: ChatMessage;

				if (responseObject.type === 'explanation_with_changes' && newCode) {
					const diff = this._computeDiff(originalCode, newCode);
					messageToPush = {
						role: 'assistant',
						type: 'explanation_with_changes',
						explanation: responseObject.explanation,
						code: newCode,
						diff: diff
					};
				} else if (responseObject.type === 'replace_file' && newCode) {
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

		private async _getLLMResponse(message: string, code: string): Promise<string> {
			return new Promise((resolve, reject) => {
				const scriptPath = path.join(this._context.extensionPath, 'src', 'pytorch_linter.py');

				const pyshell = new PythonShell(scriptPath, {
					mode: 'json', // Use JSON for sending/receiving data
					pythonOptions: ['-u'],
					pythonPath: 'python3'
				});

				// Send the user's message and code to the Python script
				pyshell.send({ command: 'chat', prompt: message, code: code });

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
				<link href="${styleUri}" rel="stylesheet">
			</head>
			<body>
				<div class="chat-container">
					<div class="messages">${messages}</div>
					<div class="input-container">
						<textarea id="message-input" placeholder="Ask for PyTorch help..." ${isDisabled}></textarea>
						<button id="send-button" ${isDisabled}>Send</button>
						<button id="clear-button" ${isDisabled}>Clear</button>
					</div>
				</div>
				<script src="${scriptUri}"></script>
			</body>
			</html>`;
		}
	}


	// ======================
	// 9. Register Chat Panel
	// ======================
    const chatProvider = new PyTorchChatProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(PyTorchChatProvider.viewType, chatProvider)
	);


    // ======================
    // 10. Register All Commands
    // ======================
    context.subscriptions.push(
        linterDisposable,
        quickFixDisposable
    );
}

export function deactivate() {}