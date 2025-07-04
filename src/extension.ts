import * as vscode from 'vscode';
import { PythonShell } from 'python-shell';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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
    // 5. Chat Command
    // ======================
    const chatDisposable = vscode.commands.registerCommand('pytorch-helper.chat', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: 'What PyTorch change would you like to make?',
            placeHolder: 'e.g. "Add batch normalization after conv layers"'
        });
        if (!prompt) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const tempFile = path.join(os.tmpdir(), `pytorch_chat_${Date.now()}.py`);
        fs.writeFileSync(tempFile, editor.document.getText());

        outputChannel.clear();
        outputChannel.appendLine(`Processing chat request: ${prompt}`);

        const scriptPath = path.join(context.extensionPath, 'src', 'pytorch_linter.py');
        const pyshell = new PythonShell(scriptPath, {
            args: [tempFile, '--chat', prompt],
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
            fs.unlinkSync(tempFile);
            if (err) {
                outputChannel.appendLine(`Error: ${err.message}`);
                vscode.window.showErrorMessage('Chat request failed');
            }
            if (suggestions.length > 0) {
                showInlineSuggestions(editor, suggestions);
            }
            outputChannel.show();
        });
    });

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
	class PyTorchChatProvider implements vscode.WebviewViewProvider {
		public static readonly viewType = 'pytorch-helper.chatView';
		private _view?: vscode.WebviewView;
		private _conversation: { role: string; content: string }[] = [];
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

			webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

			webviewView.webview.onDidReceiveMessage(async data => {
				switch (data.type) {
					case 'sendMessage':
						await this._handleUserMessage(data.message);
						break;
					case 'insertCode':
						this._insertCode(data.code);
						break;
					case 'clearChat':
						this._conversation = [];
						this._updateWebview();
						break;
				}
			});
		}

		private async _handleUserMessage(message: string) {
			if (!this._view) return;
			if (this._pendingResponse) return;
			
			this._pendingResponse = true;
			this._conversation.push({ role: 'user', content: message });
			this._updateWebview();

			try {
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					this._conversation.push({ 
						role: 'assistant', 
						content: '⚠️ No active PyTorch file found. Open a Python file to continue.' 
					});
					return;
				}

				const code = editor.document.getText();
				const response = await this._getLLMResponse(message, code);
				
				// Extract code blocks from response
				const codeBlocks = this._extractCodeBlocks(response);
				const formattedResponse = this._formatResponse(response, codeBlocks);
				
				this._conversation.push({ role: 'assistant', content: formattedResponse });
			} catch (error) {
				this._conversation.push({ 
					role: 'assistant', 
					content: `❌ Error: ${(error as Error).message}` 
				});
			} finally {
				this._pendingResponse = false;
				this._updateWebview();
			}
		}

		private async _getLLMResponse(message: string, code: string): Promise<string> {
			return new Promise((resolve, reject) => {
				const tempFile = path.join(os.tmpdir(), `pytorch_chat_${Date.now()}.py`);
				fs.writeFileSync(tempFile, code);

				const scriptPath = path.join(this._context.extensionPath, 'src', 'pytorch_linter.py');
				const pyshell = new PythonShell(scriptPath, {
					args: [tempFile, '--chat', message],
					pythonOptions: ['-u'],
					pythonPath: 'python3'
				});

				let response = '';
				pyshell.on('message', (message: string) => {
					response += message + '\n';
				});

				pyshell.end((err) => {
					fs.unlinkSync(tempFile);
					if (err) {
						reject(err);
					} else {
						resolve(response);
					}
				});
			});
		}

		private _extractCodeBlocks(response: string): string[] {
			const codeBlocks: string[] = [];
			const codeBlockRegex = /```(?:python)?\n([\s\S]*?)\n```/g;
			let match;
			
			while ((match = codeBlockRegex.exec(response)) !== null) {
				codeBlocks.push(match[1]);
			}
			
			return codeBlocks;
		}

		private _formatResponse(response: string, codeBlocks: string[]): string {
			// Replace code blocks with placeholders
			let formatted = response;
			const codeBlockRegex = /```(?:python)?\n([\s\S]*?)\n```/g;
			
			let blockIndex = 0;
			formatted = formatted.replace(codeBlockRegex, () => {
				return `\n\n**CODE BLOCK ${blockIndex++}**\n\n`;
			});

			// Add insert buttons for each code block
			codeBlocks.forEach((code, index) => {
				formatted += `\n\n<div class="code-block">
					<button data-index="${index}">Insert Code Block ${index + 1}</button>
					<pre><code>${code}</code></pre>
				</div>`;
			});

			return formatted;
		}

		private _insertCode(code: string) {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;

			const selection = editor.selection;
			const position = selection.active;

			editor.edit(editBuilder => {
				editBuilder.insert(position, code);
			}).then(() => {
				vscode.commands.executeCommand('editor.action.formatDocument');
			});
		}

		private _updateWebview() {
			if (!this._view) return;

			const messages = this._conversation.map(msg => {
				if (msg.role === 'user') {
					return `<div class="message user-message">
						<div class="avatar">👤</div>
						<div class="content">${msg.content}</div>
					</div>`;
				} else {
					return `<div class="message assistant-message">
						<div class="avatar">🤖</div>
						<div class="content">${msg.content}</div>
					</div>`;
				}
			}).join('');

			const html = this._getHtmlForWebview(this._view.webview, messages);
			this._view.webview.html = html;
		}

		private _getHtmlForWebview(webview: vscode.Webview, messages = ''): string {
			const styleUri = webview.asWebviewUri(
				vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chat.css')
			);

			const scriptUri = webview.asWebviewUri(
				vscode.Uri.joinPath(this._context.extensionUri, 'media', 'chat.js')
			);

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
						<textarea id="message-input" placeholder="Ask for PyTorch help..."></textarea>
						<button id="send-button">Send</button>
						<button id="clear-button">Clear</button>
					</div>
				</div>
				<script src="${scriptUri}"></script>
			</body>
			</html>`;
		}
	}

	// ======================
	// 11. Register Chat Panel
	// ======================
	const chatProvider = new PyTorchChatProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			PyTorchChatProvider.viewType,
			chatProvider
		)
	);

    // ======================
    // 9. Register All Commands
    // ======================
    context.subscriptions.push(
        linterDisposable,
        quickFixDisposable,
        chatDisposable
    );
}

export function deactivate() {}