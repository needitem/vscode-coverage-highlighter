import * as vscode from 'vscode';
import { getCategoryLabel } from './classification';
import { ClassificationManager } from './classificationManager';
import { FileCoverage } from './coverageParser';

export class CoverageHighlighter {
    private coveredDecorationType: vscode.TextEditorDecorationType;
    private uncoveredDecorationType: vscode.TextEditorDecorationType;
    private partialDecorationType: vscode.TextEditorDecorationType;
    private classificationManager: ClassificationManager | undefined;
    private hideClassified = false;

    constructor() {
        this.coveredDecorationType = this.createDecorationType('covered');
        this.uncoveredDecorationType = this.createDecorationType('uncovered');
        this.partialDecorationType = this.createDecorationType('partial');
    }

    public setClassificationManager(manager: ClassificationManager): void {
        this.classificationManager = manager;
    }

    public setHideClassified(hide: boolean): void {
        this.hideClassified = hide;
    }

    public getHideClassified(): boolean {
        return this.hideClassified;
    }

    private createDecorationType(
        type: 'covered' | 'uncovered' | 'partial'
    ): vscode.TextEditorDecorationType {
        const config = vscode.workspace.getConfiguration('coverageHighlighter');

        let backgroundColor: string;
        let overviewRulerColor: string;

        switch (type) {
            case 'covered':
                backgroundColor = config.get(
                    'coveredColor',
                    'rgba(0, 255, 0, 0.2)'
                );
                overviewRulerColor = 'rgba(0, 255, 0, 0.8)';
                break;
            case 'uncovered':
                backgroundColor = config.get(
                    'uncoveredColor',
                    'rgba(255, 0, 0, 0.2)'
                );
                overviewRulerColor = 'rgba(255, 0, 0, 0.8)';
                break;
            case 'partial':
                backgroundColor = config.get(
                    'partialColor',
                    'rgba(255, 255, 0, 0.2)'
                );
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

    public applyHighlights(
        editor: vscode.TextEditor,
        coverage: FileCoverage
    ): void {
        const coveredRanges: vscode.Range[] = [];
        const uncoveredRanges: vscode.DecorationOptions[] = [];
        const partialRanges: vscode.DecorationOptions[] = [];

        const document = editor.document;
        const lineCount = document.lineCount;
        const localFilePath = editor.document.uri.fsPath;
        const coverageFilePath = coverage.fileName;

        const classifiedLines = new Map<
            number,
            NonNullable<ReturnType<ClassificationManager['isClassified']>>
        >();

        if (this.classificationManager) {
            const linesToCheck = [
                ...coverage.uncoveredLines,
                ...coverage.partialCoveredLines
            ];

            for (const lineNum of linesToCheck) {
                const classified =
                    this.classificationManager.isClassified(
                        localFilePath,
                        lineNum
                    )
                    || this.classificationManager.isClassified(
                        coverageFilePath,
                        lineNum
                    );

                if (classified) {
                    classifiedLines.set(lineNum, classified);
                }
            }
        }

        for (const lineNum of coverage.coveredLines) {
            if (lineNum > 0 && lineNum <= lineCount) {
                coveredRanges.push(document.lineAt(lineNum - 1).range);
            }
        }

        for (const lineNum of coverage.uncoveredLines) {
            if (lineNum <= 0 || lineNum > lineCount) {
                continue;
            }

            const classified = classifiedLines.get(lineNum);
            if (this.hideClassified && classified) {
                continue;
            }

            uncoveredRanges.push({
                range: document.lineAt(lineNum - 1).range,
                hoverMessage: classified
                    ? this.buildClassificationHover(classified)
                    : undefined
            });
        }

        for (const lineNum of coverage.partialCoveredLines) {
            if (lineNum <= 0 || lineNum > lineCount) {
                continue;
            }

            const classified = classifiedLines.get(lineNum);
            if (this.hideClassified && classified) {
                continue;
            }

            partialRanges.push({
                range: document.lineAt(lineNum - 1).range,
                hoverMessage: classified
                    ? this.buildClassificationHover(classified)
                    : undefined
            });
        }

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

    private buildClassificationHover(
        classified: NonNullable<ReturnType<ClassificationManager['isClassified']>>
    ): vscode.MarkdownString {
        const markdown = new vscode.MarkdownString(undefined, true);
        markdown.appendMarkdown(
            `**분류:** ${getCategoryLabel(classified.category)}\n\n`
        );
        markdown.appendMarkdown(
            `**사유:** ${classified.reason || '(사유 없음)'}`
        );
        markdown.isTrusted = false;
        return markdown;
    }
}
