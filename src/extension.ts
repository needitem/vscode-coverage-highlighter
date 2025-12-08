import * as vscode from 'vscode';
import * as path from 'path';
import { parseCoverageXml, findMatchingCoverage, CoverageData, FileCoverage, normalizePath } from './coverageParser';
import { CoverageHighlighter } from './highlighter';
import { LineTracker } from './lineTracker';

let coverageData: CoverageData | undefined;
let highlighter: CoverageHighlighter;
let lineTracker: LineTracker;
let statusBarItem: vscode.StatusBarItem;

// 파일 경로 매핑 캐시 (로컬 경로 -> coverage 파일 경로)
const filePathMapping: Map<string, string> = new Map();

export function activate(context: vscode.ExtensionContext) {
    console.log('Coverage Highlighter is now active!');

    highlighter = new CoverageHighlighter();
    lineTracker = new LineTracker();

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'coverage-highlighter.showSummary';
    context.subscriptions.push(statusBarItem);

    // Register commands
    const loadCommand = vscode.commands.registerCommand('coverage-highlighter.loadCoverage', async () => {
        await loadCoverage();
    });

    const clearCommand = vscode.commands.registerCommand('coverage-highlighter.clearCoverage', () => {
        clearCoverage();
    });

    const summaryCommand = vscode.commands.registerCommand('coverage-highlighter.showSummary', () => {
        showSummary();
    });

    context.subscriptions.push(loadCommand, clearCommand, summaryCommand);

    // Apply highlights when editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && coverageData) {
                applyHighlightsToEditor(editor);
            }
        })
    );

    // Apply highlights when document is opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
            if (editor && coverageData) {
                applyHighlightsToEditor(editor);
            }
        })
    );

    // 문서 변경 시 라인 추적 및 하이라이트 업데이트
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!coverageData) {
                return;
            }

            const filePath = event.document.uri.fsPath;

            // LineTracker로 라인 변경 추적
            const changed = lineTracker.handleDocumentChange(event);

            if (changed) {
                // 변경된 라인 정보로 하이라이트 다시 적용
                const editor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.fsPath === filePath
                );
                if (editor) {
                    applyHighlightsToEditorWithTracker(editor);
                }
            }
        })
    );

    // Re-apply highlights when configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('coverageHighlighter')) {
                highlighter.refreshDecorationTypes();
                if (coverageData) {
                    applyHighlightsToAllEditors();
                }
            }
        })
    );

    context.subscriptions.push({
        dispose: () => {
            highlighter.dispose();
            lineTracker.clear();
        }
    });
}

async function loadCoverage() {
    // Select XML file
    const xmlFiles = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
            'Coverage XML': ['xml']
        },
        title: 'Select Coverage XML File'
    });

    if (!xmlFiles || xmlFiles.length === 0) {
        return;
    }

    const xmlPath = xmlFiles[0].fsPath;

    // Select project folder (optional)
    const projectFolder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select Project Folder (source files location)'
    });

    try {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Loading coverage data...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Parsing XML..." });

            // 이전 데이터 초기화
            lineTracker.clear();
            filePathMapping.clear();

            coverageData = parseCoverageXml(xmlPath);

            progress.report({ increment: 50, message: "Applying highlights..." });

            // Update status bar
            updateStatusBar();

            // Apply highlights to all visible editors
            applyHighlightsToAllEditors();

            progress.report({ increment: 100, message: "Done!" });

            const fileCount = coverageData.files.size;
            vscode.window.showInformationMessage(
                `Coverage loaded: ${fileCount} files, Statement: ${coverageData.summary.statementCov.toFixed(1)}%, Branch: ${coverageData.summary.branchCov.toFixed(1)}%`
            );
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to load coverage: ${errorMessage}`);
    }
}

function clearCoverage() {
    coverageData = undefined;
    lineTracker.clear();
    filePathMapping.clear();
    highlighter.clearAllHighlights();
    statusBarItem.hide();
    vscode.window.showInformationMessage('Coverage highlights cleared');
}

function showSummary() {
    if (!coverageData) {
        vscode.window.showWarningMessage('No coverage data loaded. Use "Coverage: Load Coverage XML" first.');
        return;
    }

    const summary = coverageData.summary;
    const panel = vscode.window.createWebviewPanel(
        'coverageSummary',
        'Coverage Summary',
        vscode.ViewColumn.Beside,
        {}
    );

    // Create file list HTML
    const fileListHtml = Array.from(coverageData.files.entries())
        .map(([fileName, coverage]) => {
            const covered = coverage.coveredLines.size;
            const uncovered = coverage.uncoveredLines.size;
            const total = covered + uncovered;
            const percentage = total > 0 ? (covered / total * 100).toFixed(1) : '0.0';
            const shortName = path.basename(fileName);
            return `
                <tr>
                    <td title="${fileName}">${shortName}</td>
                    <td>${covered}</td>
                    <td>${uncovered}</td>
                    <td>${percentage}%</td>
                </tr>
            `;
        })
        .join('');

    panel.webview.html = `
        <!DOCTYPE html>
        <html lang="ko">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Coverage Summary</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .summary-box {
                    display: flex;
                    gap: 20px;
                    margin-bottom: 30px;
                }
                .metric {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 15px 25px;
                    border-radius: 8px;
                    text-align: center;
                }
                .metric-value {
                    font-size: 2em;
                    font-weight: bold;
                    color: var(--vscode-textLink-foreground);
                }
                .metric-label {
                    font-size: 0.9em;
                    opacity: 0.8;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 20px;
                }
                th, td {
                    padding: 8px 12px;
                    text-align: left;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                th {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                tr:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                .legend {
                    margin-top: 20px;
                    display: flex;
                    gap: 20px;
                }
                .legend-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .legend-color {
                    width: 20px;
                    height: 20px;
                    border-radius: 3px;
                }
                .covered { background: rgba(0, 255, 0, 0.5); }
                .uncovered { background: rgba(255, 0, 0, 0.5); }
                .partial { background: rgba(255, 255, 0, 0.5); }
            </style>
        </head>
        <body>
            <h1>Coverage Summary</h1>

            <div class="summary-box">
                <div class="metric">
                    <div class="metric-value">${summary.statementCov.toFixed(1)}%</div>
                    <div class="metric-label">Statement Coverage</div>
                </div>
                <div class="metric">
                    <div class="metric-value">${summary.branchCov.toFixed(1)}%</div>
                    <div class="metric-label">Branch Coverage</div>
                </div>
                <div class="metric">
                    <div class="metric-value">${coverageData.files.size}</div>
                    <div class="metric-label">Files</div>
                </div>
            </div>

            <div class="legend">
                <div class="legend-item">
                    <div class="legend-color covered"></div>
                    <span>Covered (녹색)</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color uncovered"></div>
                    <span>Uncovered (적색)</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color partial"></div>
                    <span>Partial (황색)</span>
                </div>
            </div>

            <h2>Files</h2>
            <table>
                <thead>
                    <tr>
                        <th>File</th>
                        <th>Covered Lines</th>
                        <th>Uncovered Lines</th>
                        <th>Coverage</th>
                    </tr>
                </thead>
                <tbody>
                    ${fileListHtml}
                </tbody>
            </table>
        </body>
        </html>
    `;
}

function applyHighlightsToEditor(editor: vscode.TextEditor) {
    if (!coverageData) {
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const coverage = findMatchingCoverage(filePath, coverageData.files);

    if (coverage) {
        // LineTracker에 등록
        lineTracker.registerFile(filePath, {
            coveredLines: coverage.coveredLines,
            uncoveredLines: coverage.uncoveredLines,
            partialCoveredLines: coverage.partialCoveredLines
        });

        // 경로 매핑 저장
        filePathMapping.set(filePath, coverage.fileName);

        highlighter.applyHighlights(editor, coverage);
    } else {
        highlighter.clearHighlights(editor);
    }
}

function applyHighlightsToEditorWithTracker(editor: vscode.TextEditor) {
    const filePath = editor.document.uri.fsPath;
    const tracked = lineTracker.getTrackedLines(filePath);

    if (tracked) {
        // 추적된 라인 정보로 하이라이트 적용
        const coverage: FileCoverage = {
            fileName: filePathMapping.get(filePath) || filePath,
            coveredLines: tracked.coveredLines,
            uncoveredLines: tracked.uncoveredLines,
            partialCoveredLines: tracked.partialCoveredLines
        };
        highlighter.applyHighlights(editor, coverage);
    }
}

function applyHighlightsToAllEditors() {
    for (const editor of vscode.window.visibleTextEditors) {
        applyHighlightsToEditor(editor);
    }
}

function updateStatusBar() {
    if (!coverageData) {
        statusBarItem.hide();
        return;
    }

    statusBarItem.text = `$(beaker) Coverage: ${coverageData.summary.statementCov.toFixed(1)}%`;
    statusBarItem.tooltip = `Statement: ${coverageData.summary.statementCov.toFixed(1)}% | Branch: ${coverageData.summary.branchCov.toFixed(1)}%\nClick for details`;
    statusBarItem.show();
}

export function deactivate() {
    if (highlighter) {
        highlighter.dispose();
    }
    if (lineTracker) {
        lineTracker.clear();
    }
}
