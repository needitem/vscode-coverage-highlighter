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

function renderPage(title: string, content: string): string {
    return `<!DOCTYPE html>
        <html lang="ko">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${escapeHtml(title)}</title>
            <style>
                :root {
                    color-scheme: light dark;
                }
                body {
                    margin: 0;
                    padding: 24px;
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background: var(--vscode-editor-background);
                    line-height: 1.5;
                }
                .page {
                    max-width: 1180px;
                    margin: 0 auto;
                }
                .page-header {
                    margin-bottom: 20px;
                }
                .page-title {
                    margin: 0;
                    font-size: 28px;
                    font-weight: 700;
                    letter-spacing: -0.02em;
                }
                .page-subtitle {
                    margin: 8px 0 0;
                    color: var(--vscode-descriptionForeground);
                }
                .card {
                    margin-top: 16px;
                    padding: 18px 20px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 12px;
                    background: var(--vscode-editorWidget-background);
                }
                .section-title {
                    margin: 0 0 14px;
                    font-size: 18px;
                    font-weight: 600;
                }
                .metrics {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: 14px;
                    margin-top: 20px;
                }
                .metric {
                    padding: 18px;
                    border-radius: 12px;
                    border: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                .metric-value {
                    font-size: 28px;
                    font-weight: 700;
                    color: var(--vscode-textLink-foreground);
                }
                .metric-label {
                    margin-top: 6px;
                    color: var(--vscode-descriptionForeground);
                    font-size: 13px;
                }
                .legend {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                    margin-top: 18px;
                }
                .legend-item {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 12px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 999px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }
                .legend-color {
                    width: 12px;
                    height: 12px;
                    border-radius: 999px;
                }
                .covered { background: rgba(65, 181, 111, 0.95); }
                .partial { background: rgba(220, 183, 38, 0.95); }
                .uncovered { background: rgba(224, 91, 91, 0.95); }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    overflow: hidden;
                    border-radius: 10px;
                }
                thead th {
                    padding: 10px 12px;
                    text-align: left;
                    font-size: 13px;
                    font-weight: 600;
                    color: var(--vscode-descriptionForeground);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                tbody td {
                    padding: 11px 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    vertical-align: top;
                }
                tbody tr:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                tbody tr:last-child td {
                    border-bottom: none;
                }
                .numeric {
                    text-align: right;
                    white-space: nowrap;
                }
                .muted {
                    color: var(--vscode-descriptionForeground);
                }
                .empty {
                    margin: 0;
                    color: var(--vscode-descriptionForeground);
                }
                .section-stack {
                    display: grid;
                    gap: 16px;
                    margin-top: 20px;
                }
            </style>
        </head>
        <body>
            <main class="page">
                ${content}
            </main>
        </body>
        </html>`;
}

export function renderClassificationsHtml(classifications: Map<string, ClassifiedLine[]>): string {
    let sectionHtml = '';

    for (const [key, items] of Array.from(classifications.entries()).sort((left, right) =>
        left[0].localeCompare(right[0])
    )) {
        const [category, reason] = key.split(':');
        const categoryLabel = getCategoryLabel(category as ClassifiedLine['category']);

        const byFile = new Map<string, number[]>();
        for (const item of items) {
            if (!byFile.has(item.fileName)) {
                byFile.set(item.fileName, []);
            }
            byFile.get(item.fileName)!.push(item.line);
        }

        const title = `${categoryLabel}${reason ? ` - ${reason}` : ''}`;
        let rowsHtml = '';

        let index = 1;
        for (const [fileName, lines] of Array.from(byFile.entries()).sort((left, right) =>
            left[0].localeCompare(right[0])
        )) {
            lines.sort((a, b) => a - b);
            rowsHtml += `<tr>
                <td class="numeric">${index}</td>
                <td>${escapeHtml(fileName)}</td>
                <td>${escapeHtml(lines.join(', '))}</td>
                <td class="muted">${lines.length}개 라인</td>
            </tr>`;
            index++;
        }

        sectionHtml += `<section class="card">
            <h2 class="section-title">${escapeHtml(title)}</h2>
            <table>
                <thead>
                    <tr><th>번호</th><th>파일</th><th>라인</th><th>비고</th></tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </section>`;
    }

    if (sectionHtml === '') {
        sectionHtml = `<section class="card"><p class="empty">분류된 항목이 없습니다.</p></section>`;
    }

    return renderPage(
        'Coverage 분류 현황',
        `<header class="page-header">
            <h1 class="page-title">Coverage 분류 현황</h1>
            <p class="page-subtitle">문서화, 주석 예정, 커버 예정으로 분류된 미커버 라인을 확인합니다.</p>
        </header>
        <div class="section-stack">
            ${sectionHtml}
        </div>`
    );
}

export function renderCoverageSummaryHtml(coverageData: CoverageData): string {
    const fileRows = Array.from(coverageData.files.entries())
        .map(([fileName, coverage]) => {
            const covered = coverage.coveredLines.size;
            const uncovered = coverage.uncoveredLines.size;
            const partial = coverage.partialCoveredLines.size;
            const total = covered + uncovered + partial;
            const percentage = total > 0 ? (covered / total * 100).toFixed(1) : '0.0';
            const shortName = path.basename(fileName);

            return {
                covered,
                partial,
                uncovered,
                percentage: Number(percentage),
                shortName,
                fileName,
                html: `
                <tr>
                    <td title="${escapeHtml(fileName)}">${escapeHtml(shortName)}</td>
                    <td class="numeric">${covered}</td>
                    <td class="numeric">${partial}</td>
                    <td class="numeric">${uncovered}</td>
                    <td class="numeric">${percentage}%</td>
                </tr>
            `
            };
        })
        .sort((left, right) =>
            left.percentage - right.percentage
            || right.uncovered - left.uncovered
            || left.shortName.localeCompare(right.shortName)
        );

    const fileListHtml = fileRows
        .map(row => row.html)
        .join('');

    return renderPage(
        'Coverage 요약',
        `<header class="page-header">
            <h1 class="page-title">Coverage 요약</h1>
            <p class="page-subtitle">커버율이 낮은 파일부터 정렬해 우선 대응이 필요한 대상을 빠르게 확인할 수 있습니다.</p>
        </header>

        <section class="metrics">
            <div class="metric">
                <div class="metric-value">${coverageData.summary.statementCov.toFixed(1)}%</div>
                <div class="metric-label">구문 커버리지</div>
            </div>
            <div class="metric">
                <div class="metric-value">${coverageData.summary.branchCov.toFixed(1)}%</div>
                <div class="metric-label">분기 커버리지</div>
            </div>
            <div class="metric">
                <div class="metric-value">${coverageData.files.size}</div>
                <div class="metric-label">파일 수</div>
            </div>
        </section>

        <section class="card">
            <h2 class="section-title">상태 범례</h2>
            <div class="legend">
                <div class="legend-item">
                    <div class="legend-color covered"></div>
                    <span>커버됨</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color partial"></div>
                    <span>부분 커버</span>
                </div>
                <div class="legend-item">
                    <div class="legend-color uncovered"></div>
                    <span>미커버</span>
                </div>
            </div>
        </section>

        <section class="card">
            <h2 class="section-title">파일별 현황</h2>
            <table>
                <thead>
                    <tr>
                        <th>파일</th>
                        <th class="numeric">커버 라인</th>
                        <th class="numeric">부분 커버 라인</th>
                        <th class="numeric">미커버 라인</th>
                        <th class="numeric">커버율</th>
                    </tr>
                </thead>
                <tbody>
                    ${fileListHtml}
                </tbody>
            </table>
        </section>`
    );
}
