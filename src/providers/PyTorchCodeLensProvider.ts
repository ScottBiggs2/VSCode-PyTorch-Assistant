import * as vscode from 'vscode';

export class PyTorchCodeLensProvider implements vscode.CodeLensProvider {
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