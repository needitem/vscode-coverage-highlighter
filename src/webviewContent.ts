import * as path from 'path';
import { ClassifiedLine } from './classificationManager';
import { getCategoryLabel } from './classification';
import { CoverageData } from './coverageParser';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderClassificationsHtml(classifications: Map<string, ClassifiedLine[]>): string {
    let tableHtml = '';

    for (const [key, items] of classifications.entries()) {
        const [category, reason] = key.split(':');
        const categoryLabel = getCategoryLabel(category as ClassifiedLine['category']);

        const byFile = new Map<string, number[]>();
        for (const item of items) {
            if (!byFile.has(item.fileName)) {
                byFile.set(item.fileName, []);
            }
            byFile.get(item.fileName)!.push(item.line);
        }

        tableHtml += `<h3>${escapeHtml(categoryLabel)}${reason ? ` - ${escapeHtml(reason)}` : ''}</h3>`;
        tableHtml += `<table>
            <thead><tr><th>No.</th><th>File</th><th>Lines</th><th>Notes</th></tr></thead>
            <tbody>`;

        let index = 1;
        for (const [fileName, lines] of byFile.entries()) {
            lines.sort((a, b) => a - b);
            tableHtml += `<tr>
                <td>${index}</td>
                <td>${escapeHtml(fileName)}</td>
                <td>${escapeHtml(lines.join(', '))}</td>
                <td></td>
            </tr>`;
            index++;
        }

        tableHtml += '</tbody></table>';
    }

    if (tableHtml === '') {
        tableHtml = '<p>No classified lines found.</p>';
    }

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
                table { width: 100%; border-collapse: collapse; margin: 10px 0 20px; }
                th, td { padding: 8px; text-align: left; border: 1px solid var(--vscode-panel-border); }
                th { background: var(--vscode-editor-inactiveSelectionBackground); }
                h3 { margin-top: 20px; color: var(--vscode-textLink-foreground); }
            </style>
        </head>
        <body>
            <h1>Classified Uncovered Lines</h1>
            ${tableHtml}
        </body>
        </html>`;
}

export function renderCoverageSummaryHtml(coverageData: CoverageData): string {
    const fileListHtml = Array.from(coverageData.files.entries())
        .map(([fileName, coverage]) => {
            const covered = coverage.coveredLines.size;
            const uncovered = coverage.uncoveredLines.size;
            const partial = coverage.partialCoveredLines.size;
            const total = covered + uncovered + partial;
            const percentage = total > 0 ? (covered / total * 100).toFixed(1) : '0.0';
            const shortName = path.basename(fileName);

            return `
                <tr>
                    <td title="${escapeHtml(fileName)}">${escapeHtml(shortName)}</td>
                    <td>${covered}</td>
                    <td>${partial}</td>
                    <td>${uncovered}</td>
                    <td>${percentage}%</td>
                </tr>
            `;
        })
        .join('');

    return `<!DOCTYPE html>
        <html lang="en">
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
                .partial { background: rgba(255, 255, 0, 0.5); }
                .uncovered { background: rgba(255, 0, 0, 0.5); }
            </style>
        </head>
        <body>
            <h1>Coverage Summary</h1>

            <div class="summary-box">
                <div class="metric">
                    <div class="metric-value">${coverageData.summary.statementCov.toFixed(1)}%</div>
                    <div class="metric-label">Statement Coverage</div>
                </div>
                <div class="metric">
                    <div class="metric-value">${coverageData.summary.branchCov.toFixed(1)}%</div>
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
                    <span>Covered</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color partial"></div>
                    <span>Partial</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color uncovered"></div>
                    <span>Uncovered</span>
                </div>
            </div>

            <h2>Files</h2>
            <table>
                <thead>
                    <tr>
                        <th>File</th>
                        <th>Covered Lines</th>
                        <th>Partial Lines</th>
                        <th>Uncovered Lines</th>
                        <th>Coverage</th>
                    </tr>
                </thead>
                <tbody>
                    ${fileListHtml}
                </tbody>
            </table>
        </body>
        </html>`;
}
