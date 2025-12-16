import * as vscode from 'vscode';
import * as path from 'path';
import { CoverageData, FileCoverage } from './coverageParser';
import { ClassificationManager, ClassifiedLine } from './classificationManager';
import { LineTracker } from './lineTracker';

type TreeItemType = 'root' | 'category' | 'reason' | 'file' | 'line' | 'action' | 'unclassified-file';

interface TreeItemData {
    type: TreeItemType;
    label: string;
    category?: 'document' | 'comment-planned' | 'cover-planned';
    reason?: string;
    filePath?: string;
    line?: number;
    command?: string;
    isUnclassified?: boolean;
}

export class CoverageTreeDataProvider implements vscode.TreeDataProvider<TreeItemData> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItemData | undefined | null | void> = new vscode.EventEmitter<TreeItemData | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItemData | undefined | null | void> = this._onDidChangeTreeData.event;

    private coverageData: CoverageData | undefined;
    private classificationManager: ClassificationManager;
    private lineTracker: LineTracker | undefined;

    constructor(classificationManager: ClassificationManager) {
        this.classificationManager = classificationManager;
    }

    setLineTracker(lineTracker: LineTracker): void {
        this.lineTracker = lineTracker;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setCoverageData(data: CoverageData | undefined): void {
        this.coverageData = data;
        this.refresh();
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(element.label);

        switch (element.type) {
            case 'root':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                treeItem.iconPath = new vscode.ThemeIcon('folder');
                break;

            case 'category':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                if (element.category === 'document') {
                    treeItem.iconPath = new vscode.ThemeIcon('file-text');
                } else if (element.category === 'comment-planned') {
                    treeItem.iconPath = new vscode.ThemeIcon('comment');
                } else {
                    treeItem.iconPath = new vscode.ThemeIcon('flame');
                }
                break;

            case 'reason':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                treeItem.iconPath = new vscode.ThemeIcon('tag');
                break;

            case 'file':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                treeItem.iconPath = new vscode.ThemeIcon('file-code');
                if (element.filePath) {
                    treeItem.resourceUri = vscode.Uri.file(element.filePath);
                }
                break;

            case 'line':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
                treeItem.iconPath = new vscode.ThemeIcon('debug-stackframe');
                if (element.filePath && element.line) {
                    treeItem.command = {
                        command: 'coverage-highlighter.goToLine',
                        title: 'Go to Line',
                        arguments: [element.filePath, element.line]
                    };
                    // 분류된 항목인 경우 contextValue 설정 (삭제 가능하도록)
                    if (element.category) {
                        treeItem.contextValue = 'classifiedLine';
                    }
                    // 미분류 항목인 경우 contextValue 설정 (분류 가능하도록)
                    if (element.isUnclassified) {
                        treeItem.contextValue = 'unclassifiedLine';
                    }
                }
                break;

            case 'unclassified-file':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                treeItem.iconPath = new vscode.ThemeIcon('warning');
                if (element.filePath) {
                    treeItem.resourceUri = vscode.Uri.file(element.filePath);
                }
                break;

            case 'action':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
                treeItem.iconPath = new vscode.ThemeIcon('run');
                if (element.command) {
                    treeItem.command = {
                        command: element.command,
                        title: element.label
                    };
                }
                break;
        }

        return treeItem;
    }

    getChildren(element?: TreeItemData): Thenable<TreeItemData[]> {
        if (!element) {
            // Root level
            return Promise.resolve(this.getRootItems());
        }

        switch (element.type) {
            case 'root':
                if (element.label === '분류된 항목') {
                    return Promise.resolve(this.getCategoryItems());
                } else if (element.label === '커버리지 요약') {
                    return Promise.resolve(this.getCoverageSummaryItems());
                } else if (element.label === '도구') {
                    return Promise.resolve(this.getActionItems());
                } else if (element.label.startsWith('미분류')) {
                    return Promise.resolve(this.getUnclassifiedFileItems());
                }
                break;

            case 'category':
                return Promise.resolve(this.getReasonItems(element.category!));

            case 'reason':
                return Promise.resolve(this.getFileItems(element.category!, element.reason!));

            case 'file':
                return Promise.resolve(this.getLineItems(element.category!, element.reason!, element.filePath!));

            case 'unclassified-file':
                return Promise.resolve(this.getUnclassifiedLineItems(element.filePath!));
        }

        return Promise.resolve([]);
    }

    private getRootItems(): TreeItemData[] {
        const unclassifiedCount = this.getUnclassifiedCount();
        return [
            { type: 'root', label: '도구' },
            { type: 'root', label: '커버리지 요약' },
            { type: 'root', label: `미분류 (${unclassifiedCount})` },
            { type: 'root', label: '분류된 항목' }
        ];
    }

    private getUnclassifiedCount(): number {
        if (!this.coverageData) {
            return 0;
        }

        let count = 0;
        for (const [fileName, fileCoverage] of this.coverageData.files) {
            const uncoveredLines = this.getUnclassifiedLinesForFile(fileName, fileCoverage);
            count += uncoveredLines.length;
        }
        return count;
    }

    private getUnclassifiedLinesForFile(fileName: string, fileCoverage: FileCoverage): number[] {
        // uncovered + partial 라인 수집
        const allUncovered = new Set<number>([
            ...fileCoverage.uncoveredLines,
            ...fileCoverage.partialCoveredLines
        ]);

        // 분류된 라인 제외
        const unclassifiedLines: number[] = [];
        for (const line of allUncovered) {
            // fileCoverage.fileName이 coverage XML의 경로이므로 이를 사용해 분류 확인
            const isClassified = this.classificationManager.isClassified(fileCoverage.fileName, line);
            if (!isClassified) {
                unclassifiedLines.push(line);
            }
        }

        return unclassifiedLines.sort((a, b) => a - b);
    }

    private getActionItems(): TreeItemData[] {
        return [
            { type: 'action', label: 'XML 로드', command: 'coverage-highlighter.loadCoverage' },
            { type: 'action', label: '하이라이트 제거', command: 'coverage-highlighter.clearCoverage' },
            { type: 'action', label: '사유 관리', command: 'coverage-highlighter.manageReasons' },
            { type: 'action', label: '단축키 설정', command: 'coverage-highlighter.manageShortcuts' },
            { type: 'action', label: '보고서 생성', command: 'coverage-highlighter.generateReport' }
        ];
    }

    private getCoverageSummaryItems(): TreeItemData[] {
        if (!this.coverageData) {
            return [{ type: 'action', label: 'XML을 먼저 로드하세요', command: 'coverage-highlighter.loadCoverage' }];
        }

        const summary = this.coverageData.summary;
        return [
            { type: 'line', label: `Statement Coverage: ${summary.statementCov.toFixed(1)}%` },
            { type: 'line', label: `Branch Coverage: ${summary.branchCov.toFixed(1)}%` },
            { type: 'line', label: `파일 수: ${this.coverageData.files.size}` }
        ];
    }

    private getCategoryItems(): TreeItemData[] {
        const categories: TreeItemData[] = [
            { type: 'category', label: '문서', category: 'document' },
            { type: 'category', label: '주석 예정', category: 'comment-planned' },
            { type: 'category', label: '태울 예정', category: 'cover-planned' }
        ];

        // 각 카테고리의 항목 수 표시
        return categories.map(cat => {
            const classifications = this.classificationManager.getClassificationsByCategory(cat.category!);
            let count = 0;
            for (const items of classifications.values()) {
                count += items.length;
            }
            return {
                ...cat,
                label: `${cat.label} (${count})`
            };
        });
    }

    private getReasonItems(category: 'document' | 'comment-planned' | 'cover-planned'): TreeItemData[] {
        const classifications = this.classificationManager.getClassificationsByCategory(category);
        const items: TreeItemData[] = [];

        for (const [reason, lineItems] of classifications) {
            items.push({
                type: 'reason',
                label: `${reason} (${lineItems.length})`,
                category,
                reason
            });
        }

        if (items.length === 0) {
            return [{ type: 'line', label: '분류된 항목 없음' }];
        }

        return items;
    }

    private getFileItems(category: 'document' | 'comment-planned' | 'cover-planned', reason: string): TreeItemData[] {
        const classifications = this.classificationManager.getClassificationsByCategory(category);
        const items = classifications.get(reason) || [];

        // 파일별로 그룹화
        const byFile = new Map<string, ClassifiedLine[]>();
        for (const item of items) {
            if (!byFile.has(item.fileName)) {
                byFile.set(item.fileName, []);
            }
            byFile.get(item.fileName)!.push(item);
        }

        const result: TreeItemData[] = [];
        for (const [fileName, lines] of byFile) {
            const filePath = lines[0]?.filePath;
            result.push({
                type: 'file',
                label: `${fileName} (${lines.length})`,
                category,
                reason,
                filePath
            });
        }

        return result;
    }

    private getLineItems(category: 'document' | 'comment-planned' | 'cover-planned', reason: string, filePath: string): TreeItemData[] {
        const classifications = this.classificationManager.getClassificationsByCategory(category);
        const items = classifications.get(reason) || [];

        const fileItems = items.filter(i => i.filePath === filePath);
        fileItems.sort((a, b) => a.line - b.line);

        return fileItems.map(item => ({
            type: 'line' as TreeItemType,
            label: `Line ${item.line}`,
            filePath: item.filePath,
            line: item.line,
            category
        }));
    }

    private getUnclassifiedFileItems(): TreeItemData[] {
        if (!this.coverageData) {
            return [{ type: 'action', label: 'XML을 먼저 로드하세요', command: 'coverage-highlighter.loadCoverage' }];
        }

        const result: TreeItemData[] = [];

        for (const [fileName, fileCoverage] of this.coverageData.files) {
            const unclassifiedLines = this.getUnclassifiedLinesForFile(fileName, fileCoverage);
            if (unclassifiedLines.length > 0) {
                result.push({
                    type: 'unclassified-file',
                    label: `${path.basename(fileName)} (${unclassifiedLines.length})`,
                    filePath: fileCoverage.fileName
                });
            }
        }

        if (result.length === 0) {
            return [{ type: 'line', label: '모든 항목이 분류되었습니다' }];
        }

        return result;
    }

    private getUnclassifiedLineItems(filePath: string): TreeItemData[] {
        if (!this.coverageData) {
            return [];
        }

        // filePath로 coverage 찾기
        let targetCoverage: FileCoverage | undefined;
        for (const [fileName, fileCoverage] of this.coverageData.files) {
            if (fileCoverage.fileName === filePath) {
                targetCoverage = fileCoverage;
                break;
            }
        }

        if (!targetCoverage) {
            return [];
        }

        const unclassifiedLines = this.getUnclassifiedLinesForFile(targetCoverage.fileName, targetCoverage);

        // 연속된 라인을 블록으로 그룹화
        const blocks = this.groupIntoBlocks(unclassifiedLines);

        return blocks.map(block => ({
            type: 'line' as TreeItemType,
            label: block.length === 1 ? `Line ${block[0]}` : `Line ${block[0]}-${block[block.length - 1]}`,
            filePath: filePath,
            line: block[0],
            isUnclassified: true
        }));
    }

    private groupIntoBlocks(lines: number[]): number[][] {
        if (lines.length === 0) {
            return [];
        }

        const blocks: number[][] = [];
        let currentBlock: number[] = [lines[0]];

        for (let i = 1; i < lines.length; i++) {
            if (lines[i] === lines[i - 1] + 1) {
                currentBlock.push(lines[i]);
            } else {
                blocks.push(currentBlock);
                currentBlock = [lines[i]];
            }
        }
        blocks.push(currentBlock);

        return blocks;
    }
}
