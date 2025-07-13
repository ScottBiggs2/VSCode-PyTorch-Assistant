import * as vscode from 'vscode';
import { PythonShell } from 'python-shell';
import * as path from 'path';

import { PyTorchChatProvider } from './chat/ChatProvider';

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