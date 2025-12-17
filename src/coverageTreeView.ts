import * as vscode from 'vscode';
import * as path from 'path';
import { CoverageData, FileCoverage } from './coverageParser';
import { ClassificationManager, ClassifiedLine } from './classificationManager';
import { LineTracker } from './lineTracker';

type TreeItemType = 'root' | 'category' | 'reason' | 'file' | 'line' | 'action' | 'unclassified-file' | 'unclassified-line' | 'classify-option' | 'recent-xml';

interface TreeItemData {
    type: TreeItemType;
    label: string;
    category?: 'document' | 'comment-planned' | 'cover-planned';
    reason?: string;
    filePath?: string;
    line?: number;
    lines?: number[];  // 블록의 모든 라인 (연속 라인 지원)
    command?: string;
    isUnclassified?: boolean;
    xmlPath?: string;
    isCurrent?: boolean;
}

// 정렬 옵션
export type SortOption = 'name-asc' | 'name-desc' | 'count-asc' | 'count-desc' | 'path-asc' | 'path-desc';

export class CoverageTreeDataProvider implements vscode.TreeDataProvider<TreeItemData> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItemData | undefined | null | void> = new vscode.EventEmitter<TreeItemData | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItemData | undefined | null | void> = this._onDidChangeTreeData.event;

    private coverageData: CoverageData | undefined;
    private classificationManager: ClassificationManager;
    private lineTracker: LineTracker | undefined;
    private hideClassified: boolean = false;
    private treeView: vscode.TreeView<TreeItemData> | undefined;
    private recentlyClassifiedLines: Set<string> = new Set();
    private recentXmlFiles: string[] = [];
    private currentXmlPath: string | undefined;
    private expandedFilePath: string | undefined;

    // 검색 및 정렬 상태
    private searchQuery: string = '';
    private sortOption: SortOption = 'name-asc';

    constructor(classificationManager: ClassificationManager) {
        this.classificationManager = classificationManager;
    }

    // 검색 필터 설정
    setSearchQuery(query: string): void {
        this.searchQuery = query.toLowerCase().trim();
        this.refresh();
    }

    getSearchQuery(): string {
        return this.searchQuery;
    }

    clearSearch(): void {
        this.searchQuery = '';
        this.refresh();
    }

    // 정렬 옵션 설정
    setSortOption(option: SortOption): void {
        this.sortOption = option;
        this.refresh();
    }

    getSortOption(): SortOption {
        return this.sortOption;
    }

    setRecentXmlFiles(files: string[]): void {
        this.recentXmlFiles = files;
    }

    setCurrentXmlPath(xmlPath: string | undefined): void {
        this.currentXmlPath = xmlPath;
    }

    setTreeView(treeView: vscode.TreeView<TreeItemData>): void {
        this.treeView = treeView;
    }

    getTreeView(): vscode.TreeView<TreeItemData> | undefined {
        return this.treeView;
    }

    setHideClassified(hide: boolean): void {
        this.hideClassified = hide;
    }

    setLineTracker(lineTracker: LineTracker): void {
        this.lineTracker = lineTracker;
    }

    refresh(): void {
        this.recentlyClassifiedLines.clear();
        this._onDidChangeTreeData.fire();
    }

    // 분류된 라인 숨기기 (트리 갱신 후 다시 펼침)
    hideClassifiedLine(filePath: string, line: number): void {
        const key = `${filePath}:${line}`;
        this.recentlyClassifiedLines.add(key);
        this.expandedFilePath = filePath;
        
        // 트리 갱신
        this._onDidChangeTreeData.fire();
        
        // 갱신 후 파일 아이템을 다시 찾아서 펼침
        setTimeout(() => {
            const fileItem = this.findUnclassifiedFileItem(filePath);
            if (fileItem && this.treeView) {
                this.treeView.reveal(fileItem, { expand: true, select: false });
            }
        }, 100);
    }

    private findUnclassifiedFileItem(filePath: string): TreeItemData | undefined {
        if (!this.coverageData) return undefined;
        
        for (const [fileName, fileCoverage] of this.coverageData.files) {
            if (fileCoverage.fileName === filePath) {
                const unclassifiedLines = this.getUnclassifiedLinesForFile(fileName, fileCoverage);
                if (unclassifiedLines.length > 0) {
                    return {
                        type: 'unclassified-file',
                        label: `${path.basename(fileName)} (${unclassifiedLines.length})`,
                        filePath: fileCoverage.fileName
                    };
                }
            }
        }
        return undefined;
    }

    getParent(element: TreeItemData): TreeItemData | undefined {
        switch (element.type) {
            case 'unclassified-file':
                return { type: 'root', label: `미분류 (${this.getUnclassifiedCount()})` };
            case 'unclassified-line':
                if (element.filePath) {
                    return this.findUnclassifiedFileItem(element.filePath);
                }
                return undefined;
            case 'classify-option':
                if (element.filePath && element.line !== undefined) {
                    return {
                        type: 'unclassified-line',
                        label: `Line ${element.line}`,
                        filePath: element.filePath,
                        line: element.line,
                        isUnclassified: true
                    };
                }
                return undefined;
            default:
                return undefined;
        }
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

            case 'unclassified-line':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                treeItem.iconPath = new vscode.ThemeIcon('debug-stackframe');
                treeItem.contextValue = 'unclassifiedLine';  // 다중 선택 지원
                if (element.filePath && element.line) {
                    treeItem.command = {
                        command: 'coverage-highlighter.goToLine',
                        title: 'Go to Line',
                        arguments: [element.filePath, element.line]
                    };
                }
                break;

            case 'classify-option':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
                if (element.category === 'document') {
                    treeItem.iconPath = new vscode.ThemeIcon('file-text');
                } else if (element.category === 'comment-planned') {
                    treeItem.iconPath = new vscode.ThemeIcon('comment');
                } else {
                    treeItem.iconPath = new vscode.ThemeIcon('flame');
                }
                if (element.filePath && element.line !== undefined && element.category) {
                    treeItem.command = {
                        command: 'coverage-highlighter.classifyFromTreeWithReason',
                        title: 'Classify',
                        arguments: [element.filePath, element.line, element.category, element.reason || '', element.lines]
                    };
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

            case 'recent-xml':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
                if (element.isCurrent) {
                    treeItem.iconPath = new vscode.ThemeIcon('check');
                    treeItem.description = '(현재)';
                } else {
                    treeItem.iconPath = new vscode.ThemeIcon('file-code');
                }
                if (element.xmlPath) {
                    treeItem.command = {
                        command: 'coverage-highlighter.loadRecentXml',
                        title: 'Load XML',
                        arguments: [element.xmlPath]
                    };
                    treeItem.tooltip = element.xmlPath;
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

            case 'unclassified-line':
                return Promise.resolve(this.getClassifyOptions(element.filePath!, element.line!, element.lines));
        }

        return Promise.resolve([]);
    }

    private getRootItems(): TreeItemData[] {
        const unclassifiedCount = this.getUnclassifiedCount();
        const items: TreeItemData[] = [
            { type: 'root', label: '도구' }
        ];

        // 검색 중일 때 검색 상태 표시
        if (this.searchQuery) {
            items.push({ type: 'root', label: `🔍 "${this.searchQuery}" 검색 중 (${unclassifiedCount}개 일치)` });
        } else {
            items.push({ type: 'root', label: `미분류 (${unclassifiedCount})` });
        }

        items.push({ type: 'root', label: '분류된 항목' });
        return items;
    }

    private getUnclassifiedCount(): number {
        if (!this.coverageData) {
            return 0;
        }

        let count = 0;
        for (const [fileName, fileCoverage] of this.coverageData.files) {
            // 검색 필터 적용
            if (this.searchQuery && !this.matchesSearch(fileName, fileCoverage.fileName)) {
                continue;
            }
            const uncoveredLines = this.getUnclassifiedLinesForFile(fileName, fileCoverage);
            count += uncoveredLines.length;
        }
        return count;
    }

    // 검색어와 일치하는지 확인
    private matchesSearch(fileName: string, filePath: string): boolean {
        if (!this.searchQuery) {
            return true;
        }
        const query = this.searchQuery;
        const baseName = path.basename(fileName).toLowerCase();
        const fullPath = filePath.toLowerCase();
        const shortName = fileName.toLowerCase();

        // 파일명, 경로, 전체 경로에서 검색
        return baseName.includes(query) ||
               shortName.includes(query) ||
               fullPath.includes(query);
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
        const hideLabel = this.hideClassified ? '분류된 항목 보이기' : '분류된 항목 숨기기';
        const items: TreeItemData[] = [
            { type: 'action', label: 'XML 로드', command: 'coverage-highlighter.loadCoverage' }
        ];

        // 최근 XML 파일 목록 추가
        for (const xmlPath of this.recentXmlFiles) {
            items.push({
                type: 'recent-xml',
                label: path.basename(xmlPath),
                xmlPath,
                isCurrent: xmlPath === this.currentXmlPath
            });
        }

        items.push(
            { type: 'action', label: hideLabel, command: 'coverage-highlighter.toggleHideClassified' },
            { type: 'action', label: '사유 관리', command: 'coverage-highlighter.manageReasons' },
            { type: 'action', label: '보고서 생성', command: 'coverage-highlighter.generateReport' }
        );

        return items;
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

        // filePath로 그룹화 (fileName이 아닌 전체 경로로)
        const byFile = new Map<string, ClassifiedLine[]>();
        for (const item of items) {
            const key = item.filePath;  // 전체 경로 사용
            if (!byFile.has(key)) {
                byFile.set(key, []);
            }
            byFile.get(key)!.push(item);
        }

        const result: TreeItemData[] = [];
        for (const [filePath, lines] of byFile) {
            const fileName = lines[0]?.fileName || path.basename(filePath);
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

        const result: { item: TreeItemData; count: number; fileName: string; filePath: string }[] = [];

        for (const [fileName, fileCoverage] of this.coverageData.files) {
            // 검색 필터 적용
            if (this.searchQuery && !this.matchesSearch(fileName, fileCoverage.fileName)) {
                continue;
            }

            const unclassifiedLines = this.getUnclassifiedLinesForFile(fileName, fileCoverage);
            if (unclassifiedLines.length > 0) {
                result.push({
                    item: {
                        type: 'unclassified-file',
                        label: `${path.basename(fileName)} (${unclassifiedLines.length})`,
                        filePath: fileCoverage.fileName
                    },
                    count: unclassifiedLines.length,
                    fileName: path.basename(fileName),
                    filePath: fileCoverage.fileName
                });
            }
        }

        if (result.length === 0) {
            if (this.searchQuery) {
                return [{ type: 'line', label: `"${this.searchQuery}"에 일치하는 파일이 없습니다` }];
            }
            return [{ type: 'line', label: '모든 항목이 분류되었습니다' }];
        }

        // 정렬 적용
        this.sortItems(result);

        return result.map(r => r.item);
    }

    // 정렬 함수
    private sortItems(items: { item: TreeItemData; count: number; fileName: string; filePath: string }[]): void {
        switch (this.sortOption) {
            case 'name-asc':
                items.sort((a, b) => a.fileName.localeCompare(b.fileName));
                break;
            case 'name-desc':
                items.sort((a, b) => b.fileName.localeCompare(a.fileName));
                break;
            case 'count-asc':
                items.sort((a, b) => a.count - b.count);
                break;
            case 'count-desc':
                items.sort((a, b) => b.count - a.count);
                break;
            case 'path-asc':
                items.sort((a, b) => a.filePath.localeCompare(b.filePath));
                break;
            case 'path-desc':
                items.sort((a, b) => b.filePath.localeCompare(a.filePath));
                break;
        }
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
            type: 'unclassified-line' as TreeItemType,
            label: block.length === 1 ? `Line ${block[0]}` : `Line ${block[0]}-${block[block.length - 1]}`,
            filePath: filePath,
            line: block[0],
            lines: block,  // 블록의 모든 라인
            isUnclassified: true
        }));
    }

    // 분류 옵션 반환
    private getClassifyOptions(filePath: string, line: number, lines?: number[]): TreeItemData[] {
        const reasons = this.classificationManager.getReasons();
        const options: TreeItemData[] = [];
        const targetLines = lines || [line];

        // 문서 카테고리 - 사유별로 옵션 생성
        for (const reason of reasons) {
            options.push({
                type: 'classify-option',
                label: `문서: ${reason.label}`,
                category: 'document',
                reason: reason.label,
                filePath,
                line,
                lines: targetLines
            });
        }

        // 새 사유 추가 옵션
        options.push({
            type: 'classify-option',
            label: '문서: 새 사유 추가...',
            category: 'document',
            reason: '__new__',
            filePath,
            line,
            lines: targetLines
        });

        // 주석 예정
        options.push({
            type: 'classify-option',
            label: '주석 예정',
            category: 'comment-planned',
            reason: '',
            filePath,
            line,
            lines: targetLines
        });

        // 태울 예정
        options.push({
            type: 'classify-option',
            label: '태울 예정',
            category: 'cover-planned',
            reason: '',
            filePath,
            line,
            lines: targetLines
        });

        return options;
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
