import * as path from 'path';
import * as vscode from 'vscode';
import { ClassificationManager, ClassifiedLine } from './classificationManager';
import { ClassificationCategory, getCategoryLabel } from './classification';
import { CoverageData, FileCoverage } from './coverageParser';
import { LineTracker } from './lineTracker';

type TreeItemType =
    | 'root'
    | 'category'
    | 'reason'
    | 'file'
    | 'line'
    | 'action'
    | 'unclassified-file'
    | 'unclassified-line'
    | 'classify-option'
    | 'recent-xml';

type RootItemKind = 'actions' | 'unclassified' | 'classified';

interface TreeItemData {
    type: TreeItemType;
    label: string;
    rootKind?: RootItemKind;
    category?: ClassificationCategory;
    reason?: string;
    filePath?: string;
    line?: number;
    lines?: number[];
    command?: string;
    isUnclassified?: boolean;
    xmlPath?: string;
    isCurrent?: boolean;
}

interface SortableFileItem {
    item: TreeItemData;
    count: number;
    fileName: string;
    filePath: string;
}

export type SortOption =
    | 'name-asc'
    | 'name-desc'
    | 'count-asc'
    | 'count-desc'
    | 'path-asc'
    | 'path-desc';

export class CoverageTreeDataProvider implements vscode.TreeDataProvider<TreeItemData> {
    private readonly onDidChangeTreeDataEmitter =
        new vscode.EventEmitter<TreeItemData | undefined | null | void>();

    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    private coverageData: CoverageData | undefined;
    private readonly classificationManager: ClassificationManager;
    private hideClassified = false;
    private treeView: vscode.TreeView<TreeItemData> | undefined;
    private recentXmlFiles: string[] = [];
    private currentXmlPath: string | undefined;
    private searchQuery = '';
    private sortOption: SortOption = 'name-asc';
    private coverageByPath = new Map<string, FileCoverage>();
    private unclassifiedLinesCache = new Map<string, number[]>();

    constructor(classificationManager: ClassificationManager) {
        this.classificationManager = classificationManager;
    }

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

    setLineTracker(_lineTracker: LineTracker): void {
        // Kept for compatibility with the existing extension wiring.
    }

    refresh(): void {
        this.unclassifiedLinesCache.clear();
        this.onDidChangeTreeDataEmitter.fire();
    }

    hideClassifiedLine(filePath: string, _line: number): void {
        this.onDidChangeTreeDataEmitter.fire();

        setTimeout(() => {
            const fileItem = this.findUnclassifiedFileItem(filePath);
            if (fileItem && this.treeView) {
                void this.treeView.reveal(fileItem, { expand: true, select: false });
            }
        }, 100);
    }

    setCoverageData(data: CoverageData | undefined): void {
        this.coverageData = data;
        this.coverageByPath.clear();

        if (data) {
            for (const coverage of data.files.values()) {
                this.coverageByPath.set(coverage.fileName, coverage);
            }
        }

        this.refresh();
    }

    getParent(element: TreeItemData): TreeItemData | undefined {
        switch (element.type) {
            case 'unclassified-file':
                return this.createUnclassifiedRootItem();
            case 'unclassified-line':
                return element.filePath
                    ? this.findUnclassifiedFileItem(element.filePath)
                    : undefined;
            case 'classify-option':
                if (!element.filePath || element.line === undefined) {
                    return undefined;
                }

                return {
                    type: 'unclassified-line',
                    label: this.buildBlockLabel(element.lines ?? [element.line]),
                    filePath: element.filePath,
                    line: element.line,
                    lines: element.lines,
                    isUnclassified: true
                };
            default:
                return undefined;
        }
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(element.label);

        switch (element.type) {
            case 'root':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                treeItem.iconPath = new vscode.ThemeIcon(
                    element.rootKind === 'actions' ? 'tools' :
                        element.rootKind === 'classified' ? 'checklist' :
                            'warning'
                );
                break;

            case 'category':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                treeItem.iconPath = this.getCategoryIcon(element.category!);
                break;

            case 'reason':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                treeItem.iconPath = new vscode.ThemeIcon('tag');
                treeItem.tooltip = element.reason || '사유 없음';
                break;

            case 'file':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                treeItem.iconPath = new vscode.ThemeIcon('file-code');
                if (element.filePath) {
                    treeItem.resourceUri = vscode.Uri.file(element.filePath);
                    treeItem.description = path.dirname(element.filePath);
                    treeItem.tooltip = element.filePath;
                }
                break;

            case 'line':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
                treeItem.iconPath = new vscode.ThemeIcon('debug-stackframe');
                if (element.filePath && element.line) {
                    treeItem.command = {
                        command: 'coverage-highlighter.goToLine',
                        title: '라인으로 이동',
                        arguments: [element.filePath, element.line]
                    };
                    treeItem.tooltip = `${element.filePath}:${element.line}`;
                    if (element.category) {
                        treeItem.contextValue = 'classifiedLine';
                    }
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
                    treeItem.description = path.dirname(element.filePath);
                    treeItem.tooltip = element.filePath;
                }
                break;

            case 'unclassified-line':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                treeItem.iconPath = new vscode.ThemeIcon('debug-stackframe');
                treeItem.contextValue = 'unclassifiedLine';
                if (element.lines && element.lines.length > 1) {
                    treeItem.description = `${element.lines.length}라인`;
                }
                if (element.filePath && element.line) {
                    treeItem.command = {
                        command: 'coverage-highlighter.goToLine',
                        title: '라인으로 이동',
                        arguments: [element.filePath, element.line]
                    };
                    treeItem.tooltip = `${element.filePath}:${element.line}`;
                }
                break;

            case 'classify-option':
                treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
                treeItem.iconPath = this.getCategoryIcon(element.category!);
                treeItem.tooltip = `${element.label}로 분류`;
                if (element.filePath && element.line !== undefined && element.category) {
                    treeItem.command = {
                        command: 'coverage-highlighter.classifyFromTreeWithReason',
                        title: '분류',
                        arguments: [
                            element.filePath,
                            element.line,
                            element.category,
                            element.reason || '',
                            element.lines
                        ]
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
                treeItem.iconPath = new vscode.ThemeIcon(element.isCurrent ? 'check' : 'file-code');
                treeItem.description = element.isCurrent ? '(현재)' : undefined;
                if (element.xmlPath) {
                    treeItem.command = {
                        command: 'coverage-highlighter.loadRecentXml',
                        title: '최근 XML 로드',
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
            return Promise.resolve(this.getRootItems());
        }

        switch (element.type) {
            case 'root':
                if (element.rootKind === 'actions') {
                    return Promise.resolve(this.getActionItems());
                }
                if (element.rootKind === 'unclassified') {
                    return Promise.resolve(this.getUnclassifiedFileItems());
                }
                if (element.rootKind === 'classified') {
                    return Promise.resolve(this.getCategoryItems());
                }
                break;

            case 'category':
                return Promise.resolve(this.getReasonItems(element.category!));

            case 'reason':
                return Promise.resolve(this.getFileItems(element.category!, element.reason!));

            case 'file':
                return Promise.resolve(this.getLineItems(
                    element.category!,
                    element.reason!,
                    element.filePath!
                ));

            case 'unclassified-file':
                return Promise.resolve(this.getUnclassifiedLineItems(element.filePath!));

            case 'unclassified-line':
                return Promise.resolve(this.getClassifyOptions(
                    element.filePath!,
                    element.line!,
                    element.lines
                ));
        }

        return Promise.resolve([]);
    }

    private getRootItems(): TreeItemData[] {
        return [
            { type: 'root', rootKind: 'actions', label: '작업 및 최근 XML' },
            this.createUnclassifiedRootItem(),
            {
                type: 'root',
                rootKind: 'classified',
                label: `분류됨 (${this.getClassificationCount()})`
            }
        ];
    }

    private createUnclassifiedRootItem(): TreeItemData {
        const count = this.getUnclassifiedCount();

        return {
            type: 'root',
            rootKind: 'unclassified',
            label: this.searchQuery
                ? `검색 "${this.searchQuery}" (${count}건)`
                : `미분류 (${count})`
        };
    }

    private findUnclassifiedFileItem(filePath: string): TreeItemData | undefined {
        return this.getUnclassifiedFileItems().find(item => item.filePath === filePath);
    }

    private getUnclassifiedCount(): number {
        if (!this.coverageData) {
            return 0;
        }

        let count = 0;
        for (const [fileName, fileCoverage] of this.coverageData.files) {
            if (this.searchQuery && !this.matchesSearch(fileName, fileCoverage.fileName)) {
                continue;
            }

            count += this.getUnclassifiedLinesForFile(fileCoverage).length;
        }

        return count;
    }

    private getClassificationCount(): number {
        let count = 0;
        for (const items of this.classificationManager.getAllClassifications().values()) {
            count += items.length;
        }
        return count;
    }

    private matchesSearch(fileName: string, filePath: string): boolean {
        if (!this.searchQuery) {
            return true;
        }

        const query = this.searchQuery;
        return path.basename(fileName).toLowerCase().includes(query)
            || fileName.toLowerCase().includes(query)
            || filePath.toLowerCase().includes(query);
    }

    private getUnclassifiedLinesForFile(fileCoverage: FileCoverage): number[] {
        const cachedLines = this.unclassifiedLinesCache.get(fileCoverage.fileName);
        if (cachedLines) {
            return cachedLines;
        }

        const unclassifiedLines: number[] = [];
        const uncoveredLines = new Set<number>([
            ...fileCoverage.uncoveredLines,
            ...fileCoverage.partialCoveredLines
        ]);

        for (const line of uncoveredLines) {
            if (!this.classificationManager.isClassified(fileCoverage.fileName, line)) {
                unclassifiedLines.push(line);
            }
        }

        const sortedLines = unclassifiedLines.sort((a, b) => a - b);
        this.unclassifiedLinesCache.set(fileCoverage.fileName, sortedLines);
        return sortedLines;
    }

    private getActionItems(): TreeItemData[] {
        const items: TreeItemData[] = [
            { type: 'action', label: 'XML 로드', command: 'coverage-highlighter.loadCoverage' }
        ];

        for (const xmlPath of this.recentXmlFiles) {
            items.push({
                type: 'recent-xml',
                label: path.basename(xmlPath),
                xmlPath,
                isCurrent: xmlPath === this.currentXmlPath
            });
        }

        items.push(
            {
                type: 'action',
                label: this.hideClassified ? '분류된 항목 보기' : '분류된 항목 숨기기',
                command: 'coverage-highlighter.toggleHideClassified'
            },
            {
                type: 'action',
                label: '사유 관리',
                command: 'coverage-highlighter.manageReasons'
            },
            {
                type: 'action',
                label: '보고서 생성',
                command: 'coverage-highlighter.generateReport'
            }
        );

        return items;
    }

    private getCategoryItems(): TreeItemData[] {
        const categories: ClassificationCategory[] = [
            'document',
            'comment-planned',
            'cover-planned'
        ];

        return categories.map(category => {
            const classifications = this.classificationManager.getClassificationsByCategory(category);
            let count = 0;
            for (const items of classifications.values()) {
                count += items.length;
            }

            return {
                type: 'category',
                category,
                label: `${getCategoryLabel(category)} (${count})`
            };
        });
    }

    private getReasonItems(category: ClassificationCategory): TreeItemData[] {
        const classifications = this.classificationManager.getClassificationsByCategory(category);
        const items = Array.from(classifications.entries())
            .sort((left, right) =>
                left[0].localeCompare(right[0], 'ko')
                || right[1].length - left[1].length
            )
            .map<TreeItemData>(([reason, lineItems]) => ({
                type: 'reason',
                label: `${reason || '사유 없음'} (${lineItems.length})`,
                category,
                reason
            }));

        return items.length > 0
            ? items
            : [{ type: 'line', label: '분류된 항목이 없습니다' }];
    }

    private getFileItems(category: ClassificationCategory, reason: string): TreeItemData[] {
        const classifications = this.classificationManager.getClassificationsByCategory(category);
        const items = classifications.get(reason) || [];
        const itemsByFile = new Map<string, ClassifiedLine[]>();

        for (const item of items) {
            const fileItems = itemsByFile.get(item.filePath) ?? [];
            fileItems.push(item);
            itemsByFile.set(item.filePath, fileItems);
        }

        return Array.from(itemsByFile.entries())
            .sort((left, right) =>
                path.basename(left[0]).localeCompare(path.basename(right[0]), 'ko')
                || left[0].localeCompare(right[0], 'ko')
            )
            .map(([filePath, fileItems]) => ({
                type: 'file',
                label: `${fileItems[0]?.fileName || path.basename(filePath)} (${fileItems.length})`,
                category,
                reason,
                filePath
            }));
    }

    private getLineItems(
        category: ClassificationCategory,
        reason: string,
        filePath: string
    ): TreeItemData[] {
        const classifications = this.classificationManager.getClassificationsByCategory(category);
        const items = (classifications.get(reason) || [])
            .filter(item => item.filePath === filePath)
            .sort((a, b) => a.line - b.line);

        return items.map(item => ({
            type: 'line',
            label: `${item.line}라인`,
            filePath: item.filePath,
            line: item.line,
            category
        }));
    }

    private getUnclassifiedFileItems(): TreeItemData[] {
        if (!this.coverageData) {
            return [{
                type: 'action',
                label: '먼저 XML을 로드하세요',
                command: 'coverage-highlighter.loadCoverage'
            }];
        }

        const result: SortableFileItem[] = [];

        for (const [fileName, fileCoverage] of this.coverageData.files.entries()) {
            if (this.searchQuery && !this.matchesSearch(fileName, fileCoverage.fileName)) {
                continue;
            }

            const unclassifiedLines = this.getUnclassifiedLinesForFile(fileCoverage);
            if (unclassifiedLines.length === 0) {
                continue;
            }

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

        if (result.length === 0) {
            return this.searchQuery
                ? [{ type: 'line', label: `"${this.searchQuery}"와 일치하는 파일이 없습니다` }]
                : [{ type: 'line', label: '모든 항목이 분류되었습니다' }];
        }

        this.sortFileItems(result);
        return result.map(entry => entry.item);
    }

    private sortFileItems(items: SortableFileItem[]): void {
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
        const coverage = this.findCoverageByFilePath(filePath);
        if (!coverage) {
            return [];
        }

        const blocks = this.groupIntoBlocks(this.getUnclassifiedLinesForFile(coverage));
        return blocks.map(block => ({
            type: 'unclassified-line',
            label: this.buildBlockLabel(block),
            filePath,
            line: block[0],
            lines: block,
            isUnclassified: true
        }));
    }

    private findCoverageByFilePath(filePath: string): FileCoverage | undefined {
        return this.coverageByPath.get(filePath);
    }

    private getClassifyOptions(filePath: string, line: number, lines?: number[]): TreeItemData[] {
        const targetLines = lines || [line];
        const options: TreeItemData[] = this.classificationManager.getReasons().map(reason => ({
            type: 'classify-option',
            label: `문서: ${reason.label}`,
            category: 'document',
            reason: reason.label,
            filePath,
            line,
            lines: targetLines
        }));

        options.push(
            {
                type: 'classify-option',
                label: '문서: 새 사유 추가...',
                category: 'document',
                reason: '__new__',
                filePath,
                line,
                lines: targetLines
            },
            {
                type: 'classify-option',
                label: '주석 예정',
                category: 'comment-planned',
                reason: '',
                filePath,
                line,
                lines: targetLines
            },
            {
                type: 'classify-option',
                label: '커버 예정',
                category: 'cover-planned',
                reason: '',
                filePath,
                line,
                lines: targetLines
            }
        );

        return options;
    }

    private buildBlockLabel(block: number[]): string {
        return block.length === 1
            ? `${block[0]}라인`
            : `${block[0]}-${block[block.length - 1]}라인`;
    }

    private groupIntoBlocks(lines: number[]): number[][] {
        if (lines.length === 0) {
            return [];
        }

        const blocks: number[][] = [];
        let currentBlock: number[] = [lines[0]];

        for (let index = 1; index < lines.length; index++) {
            if (lines[index] === lines[index - 1] + 1) {
                currentBlock.push(lines[index]);
                continue;
            }

            blocks.push(currentBlock);
            currentBlock = [lines[index]];
        }

        blocks.push(currentBlock);
        return blocks;
    }

    private getCategoryIcon(category: ClassificationCategory): vscode.ThemeIcon {
        switch (category) {
            case 'document':
                return new vscode.ThemeIcon('file-text');
            case 'comment-planned':
                return new vscode.ThemeIcon('comment');
            case 'cover-planned':
                return new vscode.ThemeIcon('flame');
        }
    }
}
