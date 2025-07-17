import * as vscode from 'vscode';
import { PythonShell } from 'python-shell';
import * as path from 'path';

import { PyTorchCodeLensProvider } from './providers/PyTorchCodeLensProvider';
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

    interface SuggestionData {
        startLine: number;
        endLine: number;
        newText: string;
        message: string;
    }

    // ======================
    // 3. Parse LLM Output
    // ======================
    function parseSuggestionData(output: string): SuggestionData | null {
        const match = output.match(/Line (\d+)(?:-(\d+))?: (.*?):\s*(.*)/s);
        if (!match) return null;

        const startLine = parseInt(match[1]) - 1;
        const endLine = match[2] ? parseInt(match[2]) - 1 : startLine;

        return {
            startLine,
            endLine,
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
                const suggestionData = parseSuggestionData(message);
                if (suggestionData) {
                    const { startLine, endLine, newText, message } = suggestionData;
                    // Ensure line numbers are within the document's bounds
                    const validEndLine = Math.min(endLine, editor.document.lineCount - 1);
                    const range = new vscode.Range(
                        startLine, 0,
                        validEndLine, editor.document.lineAt(validEndLine).text.length
                    );
                    suggestions.push({ range, newText, message });
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
    // 8. Register CodeLens Provider
    // ======================
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