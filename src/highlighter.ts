import * as vscode from 'vscode';
import { FileCoverage } from './coverageParser';

export class CoverageHighlighter {
    private coveredDecorationType: vscode.TextEditorDecorationType;
    private uncoveredDecorationType: vscode.TextEditorDecorationType;
    private partialDecorationType: vscode.TextEditorDecorationType;
    private activeDecorations: Map<string, vscode.TextEditorDecorationType[]> = new Map();

    constructor() {
        this.coveredDecorationType = this.createDecorationType('covered');
        this.uncoveredDecorationType = this.createDecorationType('uncovered');
        this.partialDecorationType = this.createDecorationType('partial');
    }

    private createDecorationType(type: 'covered' | 'uncovered' | 'partial'): vscode.TextEditorDecorationType {
        const config = vscode.workspace.getConfiguration('coverageHighlighter');

        let backgroundColor: string;
        let gutterIconPath: string | undefined;
        let overviewRulerColor: string;

        switch (type) {
            case 'covered':
                backgroundColor = config.get('coveredColor', 'rgba(0, 255, 0, 0.2)');
                overviewRulerColor = 'rgba(0, 255, 0, 0.8)';
                break;
            case 'uncovered':
                backgroundColor = config.get('uncoveredColor', 'rgba(255, 0, 0, 0.2)');
                overviewRulerColor = 'rgba(255, 0, 0, 0.8)';
                break;
            case 'partial':
                backgroundColor = config.get('partialColor', 'rgba(255, 255, 0, 0.2)');
                overviewRulerColor = 'rgba(255, 255, 0, 0.8)';
                break;
        }

        return vscode.window.createTextEditorDecorationType({
            backgroundColor,
            isWholeLine: true,
            overviewRulerColor,
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
    }

    public applyHighlights(editor: vscode.TextEditor, coverage: FileCoverage): void {
        const coveredRanges: vscode.Range[] = [];
        const uncoveredRanges: vscode.Range[] = [];
        const partialRanges: vscode.Range[] = [];

        const document = editor.document;
        const lineCount = document.lineCount;

        // Create ranges for covered lines
        for (const lineNum of coverage.coveredLines) {
            if (lineNum > 0 && lineNum <= lineCount) {
                const line = document.lineAt(lineNum - 1); // Convert to 0-based
                coveredRanges.push(line.range);
            }
        }

        // Create ranges for uncovered lines
        for (const lineNum of coverage.uncoveredLines) {
            if (lineNum > 0 && lineNum <= lineCount) {
                const line = document.lineAt(lineNum - 1);
                uncoveredRanges.push(line.range);
            }
        }

        // Create ranges for partial covered lines
        for (const lineNum of coverage.partialCoveredLines) {
            if (lineNum > 0 && lineNum <= lineCount) {
                const line = document.lineAt(lineNum - 1);
                partialRanges.push(line.range);
            }
        }

        // Apply decorations
        editor.setDecorations(this.coveredDecorationType, coveredRanges);
        editor.setDecorations(this.uncoveredDecorationType, uncoveredRanges);
        editor.setDecorations(this.partialDecorationType, partialRanges);
    }

    public clearHighlights(editor: vscode.TextEditor): void {
        editor.setDecorations(this.coveredDecorationType, []);
        editor.setDecorations(this.uncoveredDecorationType, []);
        editor.setDecorations(this.partialDecorationType, []);
    }

    public clearAllHighlights(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.clearHighlights(editor);
        }
    }

    public dispose(): void {
        this.coveredDecorationType.dispose();
        this.uncoveredDecorationType.dispose();
        this.partialDecorationType.dispose();
    }

    public refreshDecorationTypes(): void {
        this.coveredDecorationType.dispose();
        this.uncoveredDecorationType.dispose();
        this.partialDecorationType.dispose();

        this.coveredDecorationType = this.createDecorationType('covered');
        this.uncoveredDecorationType = this.createDecorationType('uncovered');
        this.partialDecorationType = this.createDecorationType('partial');
    }
}
