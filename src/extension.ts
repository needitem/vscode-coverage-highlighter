import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClassificationCategory, getCategoryLabel } from './classification';
import {
    ClassificationSelection,
    promptForClassification,
    promptForNewReason,
    promptForReason
} from './classificationPrompts';
import {
    ClassifiedLine,
    ClassificationManager,
    ClassificationTarget
} from './classificationManager';
import { loadCoverageCache, saveCoverageCache } from './coverageCache';
import {
    CoverageData,
    FileCoverage,
    findLocalFilePathAsync,
    findMatchingCoverage,
    parseCoverageXml
} from './coverageParser';
import { CoverageTreeDataProvider, SortOption } from './coverageTreeView';
import { CoverageHighlighter } from './highlighter';
import { LineTracker } from './lineTracker';
import {
    renderClassificationsHtml,
    renderCoverageSummaryHtml
} from './webviewContent';

let coverageData: CoverageData | undefined;
let highlighter: CoverageHighlighter;
let lineTracker: LineTracker;
let classificationManager: ClassificationManager;
let treeDataProvider: CoverageTreeDataProvider;
let statusBarItem: vscode.StatusBarItem;

const filePathMapping = new Map<string, string>();
const MAX_RECENT_FILES = 10;

let recentXmlFiles: string[] = [];
let currentXmlPath: string | undefined;
let saveTimeout: NodeJS.Timeout | undefined;

interface TreeSelectionItem {
    type?: string;
    filePath?: string;
    line?: number;
    lines?: number[];
    category?: ClassificationCategory;
}

interface QuickSlotConfig {
    category: ClassificationCategory;
    reason?: string;
}

export function activate(context: vscode.ExtensionContext): void {
    highlighter = new CoverageHighlighter();
    lineTracker = new LineTracker();
    classificationManager = new ClassificationManager(context);

    highlighter.setClassificationManager(classificationManager);

    treeDataProvider = new CoverageTreeDataProvider(classificationManager);
    treeDataProvider.setLineTracker(lineTracker);

    const treeView = vscode.window.createTreeView('coverageExplorer', {
        treeDataProvider,
        canSelectMany: true
    });

    treeDataProvider.setTreeView(treeView);
    context.subscriptions.push(treeView);

    restoreCachedState();

    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'coverage-highlighter.showSummary';

    treeDataProvider.setRecentXmlFiles(recentXmlFiles);
    treeDataProvider.setCurrentXmlPath(currentXmlPath);

    const commands = [
        vscode.commands.registerCommand('coverage-highlighter.loadCoverage', () => loadCoverage()),
        vscode.commands.registerCommand('coverage-highlighter.refreshTree', () => treeDataProvider.refresh()),
        vscode.commands.registerCommand('coverage-highlighter.goToLine', (filePath: string, line: number) => goToLine(filePath, line)),
        vscode.commands.registerCommand('coverage-highlighter.clearCoverage', () => void clearCoverage()),
        vscode.commands.registerCommand('coverage-highlighter.showSummary', () => showSummary()),
        vscode.commands.registerCommand('coverage-highlighter.classifyLine', () => void classifyCurrentLine()),
        vscode.commands.registerCommand('coverage-highlighter.classifySelection', () => void classifySelectedLines()),
        vscode.commands.registerCommand('coverage-highlighter.manageReasons', () => void manageReasons()),
        vscode.commands.registerCommand('coverage-highlighter.generateReport', () => void generateReport()),
        vscode.commands.registerCommand('coverage-highlighter.showClassifications', () => void showClassifications()),
        vscode.commands.registerCommand('coverage-highlighter.removeClassification', (item: TreeSelectionItem) => void removeClassification(item)),
        vscode.commands.registerCommand('coverage-highlighter.quickClassifyDocument', () => void executeQuickSlot(1)),
        vscode.commands.registerCommand('coverage-highlighter.quickClassifyComment', () => void executeQuickSlot(2)),
        vscode.commands.registerCommand('coverage-highlighter.quickClassifyCover', () => void executeQuickSlot(3)),
        vscode.commands.registerCommand('coverage-highlighter.quickSlot4', () => void executeQuickSlot(4)),
        vscode.commands.registerCommand('coverage-highlighter.quickSlot5', () => void executeQuickSlot(5)),
        vscode.commands.registerCommand('coverage-highlighter.quickSlot6', () => void executeQuickSlot(6)),
        vscode.commands.registerCommand('coverage-highlighter.quickSlot7', () => void executeQuickSlot(7)),
        vscode.commands.registerCommand('coverage-highlighter.quickSlot8', () => void executeQuickSlot(8)),
        vscode.commands.registerCommand('coverage-highlighter.quickSlot9', () => void executeQuickSlot(9)),
        vscode.commands.registerCommand('coverage-highlighter.classifyFromTree', (item: TreeSelectionItem) => void classifyFromTree(item)),
        vscode.commands.registerCommand('coverage-highlighter.quickClassifyFromTreeDocument', (item: TreeSelectionItem) => void quickClassifyFromTree(item, 'document')),
        vscode.commands.registerCommand('coverage-highlighter.quickClassifyFromTreeComment', (item: TreeSelectionItem) => void quickClassifyFromTree(item, 'comment-planned')),
        vscode.commands.registerCommand('coverage-highlighter.quickClassifyFromTreeCover', (item: TreeSelectionItem) => void quickClassifyFromTree(item, 'cover-planned')),
        vscode.commands.registerCommand('coverage-highlighter.toggleHideClassified', () => toggleHideClassified()),
        vscode.commands.registerCommand('coverage-highlighter.loadRecentXml', (xmlPath: string) => void loadXmlFile(xmlPath)),
        vscode.commands.registerCommand(
            'coverage-highlighter.classifyFromTreeWithReason',
            (filePath: string, line: number, category: ClassificationCategory, reason: string, lines?: number[]) =>
                void classifyFromTreeWithReason(filePath, line, category, reason, lines)
        ),
        vscode.commands.registerCommand('coverage-highlighter.bulkClassify', () => void bulkClassify()),
        vscode.commands.registerCommand('coverage-highlighter.bulkRemoveClassification', () => void bulkRemoveClassification()),
        vscode.commands.registerCommand('coverage-highlighter.bulkEditClassification', () => void bulkEditClassification()),
        vscode.commands.registerCommand('coverage-highlighter.searchFiles', () => void searchFiles()),
        vscode.commands.registerCommand('coverage-highlighter.clearSearch', () => clearSearch()),
        vscode.commands.registerCommand('coverage-highlighter.sortFiles', () => void sortFiles()),
        vscode.commands.registerCommand('coverage-highlighter.clearAllClassifications', () => void clearAllClassifications()),
        vscode.commands.registerCommand('coverage-highlighter.editClassification', (item: TreeSelectionItem) => void editClassification(item))
    ];

    context.subscriptions.push(
        statusBarItem,
        ...commands,
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && coverageData) {
                applyHighlightsToEditor(editor);
            }
        }),
        vscode.workspace.onDidOpenTextDocument(document => {
            const editor = vscode.window.visibleTextEditors.find(
                candidate => candidate.document === document
            );
            if (editor && coverageData) {
                applyHighlightsToEditor(editor);
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!coverageData) {
                return;
            }

            const changed = lineTracker.handleDocumentChange(event);
            if (!changed) {
                return;
            }

            const editor = vscode.window.visibleTextEditors.find(
                candidate => candidate.document.uri.fsPath === event.document.uri.fsPath
            );

            if (editor) {
                applyHighlightsToEditorWithTracker(editor);
            }

            debouncedSaveCache();
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('coverageHighlighter')) {
                return;
            }

            highlighter.refreshDecorationTypes();
            if (coverageData) {
                applyHighlightsToAllEditors();
            }
        }),
        {
            dispose: () => {
                if (saveTimeout) {
                    clearTimeout(saveTimeout);
                }

                void saveCache();
                highlighter.dispose();
                lineTracker.clear();
            }
        }
    );
}

function restoreCachedState(): void {
    const cache = loadCoverageCache();
    if (!cache) {
        return;
    }

    lineTracker.importOffsets(cache.lineOffsets);
    recentXmlFiles = cache.recentXmlFiles.filter(filePath => fs.existsSync(filePath));

    if (cache.xmlPath && fs.existsSync(cache.xmlPath)) {
        currentXmlPath = cache.xmlPath;
    }
}

async function saveCache(): Promise<void> {
    const lineOffsets: Record<string, Record<number, number>> = {};

    for (const [filePath, offsets] of lineTracker.exportOffsets().entries()) {
        lineOffsets[filePath] = Object.fromEntries(offsets);
    }

    await saveCoverageCache({
        xmlPath: currentXmlPath,
        recentXmlFiles,
        lineOffsets
    });
}

function debouncedSaveCache(): void {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }

    saveTimeout = setTimeout(() => {
        void saveCache();
    }, 2000);
}

function addToRecentFiles(xmlPath: string): void {
    recentXmlFiles = recentXmlFiles.filter(existingPath => existingPath !== xmlPath);
    recentXmlFiles.unshift(xmlPath);
    recentXmlFiles = recentXmlFiles.slice(0, MAX_RECENT_FILES);
}

function getRecentXmlFiles(): Array<{ label: string; description: string; path: string }> {
    return recentXmlFiles
        .filter(filePath => fs.existsSync(filePath))
        .map(filePath => ({
            label: path.basename(filePath),
            description: path.dirname(filePath),
            path: filePath
        }));
}

async function goToLine(filePath: string, line: number): Promise<void> {
    let targetPath = filePath;

    if (!fs.existsSync(filePath)) {
        const localPath = await findLocalFilePathAsync(filePath);
        if (!localPath) {
            vscode.window.showWarningMessage(`파일을 찾을 수 없습니다: ${path.basename(filePath)}`);
            return;
        }

        targetPath = localPath;
    }

    try {
        const document = await vscode.workspace.openTextDocument(targetPath);
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    } catch {
        vscode.window.showWarningMessage(`파일을 열 수 없습니다: ${path.basename(targetPath)}`);
    }
}

async function loadCoverage(): Promise<void> {
    const recentFiles = getRecentXmlFiles();
    let xmlPath: string | undefined;

    if (recentFiles.length > 0) {
        const items: Array<vscode.QuickPickItem & { path?: string }> = [
            {
                label: '$(folder-opened) 다른 XML 파일 선택...',
                description: '파일 선택기로 새 XML을 엽니다'
            },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...recentFiles.map(file => ({
                label: `${file.path === currentXmlPath ? '$(check)' : '$(history)'} ${file.label}`,
                description: file.description,
                path: file.path
            }))
        ];

        const choice = await vscode.window.showQuickPick(items, {
            placeHolder: 'Coverage XML 파일을 선택하세요',
            title: 'Coverage XML 로드'
        });

        if (!choice) {
            return;
        }

        xmlPath = choice.path ?? await promptForXmlFile();
    } else {
        xmlPath = await promptForXmlFile();
    }

    if (xmlPath) {
        await loadXmlFile(xmlPath);
    }
}

async function promptForXmlFile(): Promise<string | undefined> {
    const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Coverage XML': ['xml'] },
        title: 'Coverage XML 파일 선택'
    });

    return files?.[0]?.fsPath;
}

async function loadXmlFile(xmlPath: string): Promise<void> {
    if (!fs.existsSync(xmlPath)) {
        vscode.window.showErrorMessage(`파일을 찾을 수 없습니다: ${xmlPath}`);
        return;
    }

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Coverage 데이터를 불러오는 중...',
                cancellable: false
            },
            async progress => {
                progress.report({ increment: 0, message: 'XML을 파싱하는 중...' });

                filePathMapping.clear();
                coverageData = parseCoverageXml(xmlPath);
                currentXmlPath = xmlPath;
                addToRecentFiles(xmlPath);

                progress.report({ increment: 50, message: '하이라이트를 적용하는 중...' });

                updateStatusBar();
                applyHighlightsToAllEditors();

                treeDataProvider.setCoverageData(coverageData);
                treeDataProvider.setCurrentXmlPath(currentXmlPath);
                treeDataProvider.setRecentXmlFiles(recentXmlFiles);

                await saveCache();

                progress.report({ increment: 100, message: '완료' });
                vscode.window.showInformationMessage(
                    `Coverage 로드 완료: ${coverageData.files.size}개 파일, `
                    + `구문 ${coverageData.summary.statementCov.toFixed(1)}%, `
                    + `분기 ${coverageData.summary.branchCov.toFixed(1)}%`
                );
            }
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Coverage 로드 실패: ${message}`);
    }
}

async function clearCoverage(): Promise<void> {
    coverageData = undefined;
    currentXmlPath = undefined;
    lineTracker.clear();
    filePathMapping.clear();
    highlighter.clearAllHighlights();
    statusBarItem.hide();
    treeDataProvider.setCoverageData(undefined);
    treeDataProvider.setCurrentXmlPath(undefined);
    await saveCache();
    vscode.window.showInformationMessage('Coverage 하이라이트를 초기화했습니다.');
}

async function classifyCurrentLine(): Promise<void> {
    const editor = getActiveEditorOrWarn();
    if (!editor) {
        return;
    }

    const line = editor.selection.active.line + 1;
    const filePath = editor.document.uri.fsPath;
    const blockLines = lineTracker.getUncoveredBlock(filePath, line);

    await classifyLines(filePath, blockLines);
}

async function classifySelectedLines(): Promise<void> {
    const editor = getActiveEditorOrWarn();
    if (!editor) {
        return;
    }

    const lines = new Set<number>();
    const filePath = editor.document.uri.fsPath;
    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;

    for (let line = startLine; line <= endLine; line++) {
        for (const blockLine of lineTracker.getUncoveredBlock(filePath, line)) {
            lines.add(blockLine);
        }
    }

    await classifyLines(
        filePath,
        Array.from(lines).sort((left, right) => left - right)
    );
}

async function classifyLines(filePath: string, lines: number[]): Promise<void> {
    const selection = await promptForClassification(classificationManager, {
        categoryPlaceHolder: '분류 카테고리를 선택하세요',
        reasonPlaceHolder: '사유를 선택하세요'
    });

    if (!selection) {
        return;
    }

    await applyClassificationTargets(
        toTargets(filePath, lines),
        selection,
        { message: buildClassificationMessage(lines.length, selection) }
    );
}

async function executeQuickSlot(slotNumber: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('coverageHighlighter');
    const slotConfig = config.get<QuickSlotConfig>(`quickSlot${slotNumber}`);

    if (!slotConfig?.category) {
        vscode.window.showWarningMessage(
            `빠른 분류 슬롯 ${slotNumber}이 설정되지 않았습니다. coverageHighlighter.quickSlot${slotNumber}을 먼저 설정하세요.`
        );
        return;
    }

    const editor = getActiveEditorOrWarn();
    if (!editor) {
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const line = editor.selection.active.line + 1;
    const blockLines = lineTracker.getUncoveredBlock(filePath, line);

    const reason = slotConfig.reason?.trim()
        || await promptForReason(classificationManager, slotConfig.category, '사유를 선택하세요');

    if (reason === undefined) {
        return;
    }

    await applyClassificationTargets(
        toTargets(filePath, blockLines),
        {
            category: slotConfig.category,
            reason
        },
        {
            message: buildClassificationMessage(blockLines.length, {
                category: slotConfig.category,
                reason
            })
        }
    );
}

async function classifyFromTree(item: TreeSelectionItem): Promise<void> {
    if (!item.filePath || item.line === undefined) {
        return;
    }

    await classifyLines(item.filePath, item.lines ?? [item.line]);
}

async function quickClassifyFromTree(
    item: TreeSelectionItem,
    category: ClassificationCategory
): Promise<void> {
    if (!item.filePath || item.line === undefined) {
        return;
    }

    const lines = item.lines ?? [item.line];
    const reason = await promptForReason(
        classificationManager,
        category,
        '사유를 선택하세요'
    );

    if (reason === undefined) {
        return;
    }

    await applyClassificationTargets(
        toTargets(item.filePath, lines),
        { category, reason },
        {
            hideFromTree: true,
            message: buildClassificationMessage(lines.length, { category, reason })
        }
    );
}

async function classifyFromTreeWithReason(
    filePath: string,
    line: number,
    category: ClassificationCategory,
    reason: string,
    lines?: number[]
): Promise<void> {
    const finalReason = reason === '__new__'
        ? await promptForNewReason(classificationManager)
        : reason;

    if (finalReason === undefined) {
        return;
    }

    const targetLines = lines && lines.length > 0 ? lines : [line];
    await applyClassificationTargets(
        toTargets(filePath, targetLines),
        { category, reason: finalReason },
        {
            hideFromTree: true,
            message: buildClassificationMessage(targetLines.length, {
                category,
                reason: finalReason
            })
        }
    );
}

async function bulkClassify(): Promise<void> {
    const selectedItems = treeDataProvider.getTreeView()?.selection ?? [];
    const unclassifiedItems = selectedItems.filter(
        item => item.type === 'unclassified-line' && item.filePath
    );

    const targets = flattenTreeTargets(unclassifiedItems);
    if (targets.length === 0) {
        vscode.window.showWarningMessage('분류할 미분류 라인을 선택하세요.');
        return;
    }

    const selection = await promptForClassification(classificationManager, {
        categoryPlaceHolder: '선택한 라인의 분류 카테고리를 선택하세요',
        reasonPlaceHolder: '사유를 선택하세요'
    });

    if (!selection) {
        return;
    }

    await applyClassificationTargets(targets, selection, {
        message: buildClassificationMessage(targets.length, selection)
    });
}

async function bulkRemoveClassification(): Promise<void> {
    const selectedItems = treeDataProvider.getTreeView()?.selection ?? [];
    const classifiedItems = selectedItems.filter(
        item => item.type === 'line' && item.filePath && item.line !== undefined && item.category
    );

    const targets = flattenTreeTargets(classifiedItems);
    if (targets.length === 0) {
        vscode.window.showWarningMessage('삭제할 분류 라인을 선택하세요.');
        return;
    }

    const confirmation = await vscode.window.showWarningMessage(
        `선택한 ${targets.length}개 라인의 분류를 삭제하시겠습니까?`,
        '삭제',
        '취소'
    );

    if (confirmation !== '삭제') {
        return;
    }

    await classificationManager.removeClassifications(targets);
    await refreshViewsAfterClassificationChange();
    vscode.window.showInformationMessage(`${targets.length}개 분류를 삭제했습니다.`);
}

async function bulkEditClassification(): Promise<void> {
    const selectedItems = treeDataProvider.getTreeView()?.selection ?? [];
    const classifiedItems = selectedItems.filter(
        item => item.type === 'line' && item.filePath && item.line !== undefined && item.category
    );

    const targets = flattenTreeTargets(classifiedItems);
    if (targets.length === 0) {
        vscode.window.showWarningMessage('수정할 분류 라인을 선택하세요.');
        return;
    }

    const selection = await promptForClassification(classificationManager, {
        categoryPlaceHolder: '새 분류 카테고리를 선택하세요',
        reasonPlaceHolder: '사유를 선택하세요'
    });

    if (!selection) {
        return;
    }

    await applyClassificationTargets(targets, selection, {
        message: `${targets.length}개 라인을 ${getCategoryLabel(selection.category)}(으)로 수정했습니다`
            + (selection.reason ? ` (${selection.reason})` : '')
    });
}

async function removeClassification(item: TreeSelectionItem): Promise<void> {
    if (!item.filePath || item.line === undefined) {
        return;
    }

    await classificationManager.removeClassification(item.filePath, item.line);
    await refreshViewsAfterClassificationChange();
    vscode.window.showInformationMessage(`${item.line}라인의 분류를 삭제했습니다.`);
}

async function editClassification(item: TreeSelectionItem): Promise<void> {
    if (!item.filePath || item.line === undefined) {
        vscode.window.showWarningMessage('수정할 분류 라인을 선택하세요.');
        return;
    }

    const selection = await promptForClassification(classificationManager, {
        categoryPlaceHolder: '새 분류 카테고리를 선택하세요',
        reasonPlaceHolder: '사유를 선택하세요'
    });

    if (!selection) {
        return;
    }

    await applyClassificationTargets(
        [{ filePath: item.filePath, line: item.line }],
        selection,
        {
            message: `${item.line}라인을 ${getCategoryLabel(selection.category)}(으)로 수정했습니다`
                + (selection.reason ? ` (${selection.reason})` : '')
        }
    );
}

function toggleHideClassified(): void {
    const nextValue = !highlighter.getHideClassified();
    highlighter.setHideClassified(nextValue);
    treeDataProvider.setHideClassified(nextValue);
    applyHighlightsToAllEditors();
    treeDataProvider.refresh();
    vscode.window.showInformationMessage(`분류된 항목 숨기기: ${nextValue ? 'ON' : 'OFF'}`);
}

async function searchFiles(): Promise<void> {
    const query = await vscode.window.showInputBox({
        prompt: '필터링할 파일명 또는 경로를 입력하세요',
        placeHolder: '예: Controller, src/main, .java',
        value: treeDataProvider.getSearchQuery()
    });

    if (query === undefined) {
        return;
    }

    if (query.trim() === '') {
        treeDataProvider.clearSearch();
        vscode.window.showInformationMessage('검색을 초기화했습니다.');
        return;
    }

    treeDataProvider.setSearchQuery(query);
    vscode.window.showInformationMessage(`"${query}" 검색을 적용했습니다.`);
}

function clearSearch(): void {
    treeDataProvider.clearSearch();
    vscode.window.showInformationMessage('검색을 초기화했습니다.');
}

async function sortFiles(): Promise<void> {
    const currentSort = treeDataProvider.getSortOption();
    const sortOptions: Array<{ label: string; value: SortOption; description?: string }> = [
        { label: '파일명 (A-Z)', value: 'name-asc', description: currentSort === 'name-asc' ? '현재 선택' : '' },
        { label: '파일명 (Z-A)', value: 'name-desc', description: currentSort === 'name-desc' ? '현재 선택' : '' },
        { label: '미분류 개수 (적은 순)', value: 'count-asc', description: currentSort === 'count-asc' ? '현재 선택' : '' },
        { label: '미분류 개수 (많은 순)', value: 'count-desc', description: currentSort === 'count-desc' ? '현재 선택' : '' },
        { label: '경로 (A-Z)', value: 'path-asc', description: currentSort === 'path-asc' ? '현재 선택' : '' },
        { label: '경로 (Z-A)', value: 'path-desc', description: currentSort === 'path-desc' ? '현재 선택' : '' }
    ];

    const choice = await vscode.window.showQuickPick(sortOptions, {
        placeHolder: '정렬 방식을 선택하세요'
    });

    if (!choice) {
        return;
    }

    treeDataProvider.setSortOption(choice.value);
    vscode.window.showInformationMessage(`정렬 적용: ${choice.label}`);
}

async function clearAllClassifications(): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
        '저장된 모든 분류를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.',
        '전체 삭제',
        '취소'
    );

    if (confirmation !== '전체 삭제') {
        return;
    }

    await classificationManager.clearAll();
    await refreshViewsAfterClassificationChange();
    vscode.window.showInformationMessage('모든 분류를 삭제했습니다.');
}

async function manageReasons(): Promise<void> {
    const reasons = classificationManager.getReasons();
    const choice = await vscode.window.showQuickPick(
        [
            { label: '$(add) 사유 추가', value: '__add__' },
            ...reasons.map(reason => ({
                label: `$(trash) ${reason.label}`,
                value: reason.id,
                description: '이 사유를 삭제합니다'
            }))
        ],
        { placeHolder: '문서 분류 사유를 관리하세요' }
    );

    if (!choice) {
        return;
    }

    if (choice.value === '__add__') {
        const newReason = await promptForNewReason(classificationManager);
        if (newReason) {
            vscode.window.showInformationMessage(`사유를 추가했습니다: "${newReason}"`);
        }
        return;
    }

    const label = choice.label.replace('$(trash) ', '');
    const confirmation = await vscode.window.showWarningMessage(
        `"${label}" 사유를 삭제하시겠습니까? 기존 분류에는 현재 라벨이 유지됩니다.`,
        '삭제',
        '취소'
    );

    if (confirmation !== '삭제') {
        return;
    }

    await classificationManager.removeReason(choice.value);
    vscode.window.showInformationMessage(`사유를 삭제했습니다: "${label}"`);
}

async function generateReport(): Promise<void> {
    const reportType = await vscode.window.showQuickPick(
        [
            { label: '문서 보고서', value: 'document' },
            { label: '전체 보고서', value: 'full' }
        ],
        { placeHolder: '보고서 유형을 선택하세요' }
    );

    if (!reportType) {
        return;
    }

    const report = reportType.value === 'document'
        ? classificationManager.generateDocumentReport()
        : classificationManager.generateFullReport();

    const document = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown'
    });

    await vscode.window.showTextDocument(document);
}

async function showClassifications(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        'coverageClassifications',
        'Coverage 분류 현황',
        vscode.ViewColumn.Beside,
        { enableScripts: false }
    );

    panel.webview.html = renderClassificationsHtml(
        getVisibleClassifications()
    );
}

function getVisibleClassifications(): Map<string, ClassifiedLine[]> {
    if (!coverageData) {
        return classificationManager.getAllClassifications();
    }

    const result = new Map<string, ClassifiedLine[]>();

    for (const [key, items] of classificationManager.getAllClassifications().entries()) {
        const visibleItems = items.filter(item => {
            const coverage = findMatchingCoverage(item.filePath, coverageData!.files);
            if (!coverage) {
                return true;
            }

            return coverage.uncoveredLines.has(item.line)
                || coverage.partialCoveredLines.has(item.line);
        });

        if (visibleItems.length > 0) {
            result.set(key, visibleItems);
        }
    }

    return result;
}

function showSummary(): void {
    if (!coverageData) {
        vscode.window.showWarningMessage(
            'Coverage 데이터가 없습니다. 먼저 "Coverage: XML 불러오기"를 실행하세요.'
        );
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'coverageSummary',
        'Coverage 요약',
        vscode.ViewColumn.Beside,
        {}
    );

    panel.webview.html = renderCoverageSummaryHtml(coverageData);
}

function getActiveEditorOrWarn(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('활성 에디터가 없습니다.');
    }
    return editor;
}

function toTargets(filePath: string, lines: number[]): ClassificationTarget[] {
    return lines.map(line => ({ filePath, line }));
}

function flattenTreeTargets(items: readonly TreeSelectionItem[]): ClassificationTarget[] {
    return items.flatMap(item => {
        if (!item.filePath) {
            return [];
        }

        const lines = item.lines && item.lines.length > 0
            ? item.lines
            : item.line !== undefined
                ? [item.line]
                : [];

        return lines.map(line => ({
            filePath: item.filePath!,
            line
        }));
    });
}

async function applyClassificationTargets(
    targets: ClassificationTarget[],
    selection: ClassificationSelection,
    options: {
        hideFromTree?: boolean;
        message?: string;
    } = {}
): Promise<void> {
    if (targets.length === 0) {
        return;
    }

    await classificationManager.classifyTargets(
        targets,
        selection.category,
        selection.reason
    );

    if (options.hideFromTree) {
        for (const target of targets) {
            treeDataProvider.hideClassifiedLine(target.filePath, target.line);
        }
    }

    await refreshViewsAfterClassificationChange();

    if (options.message) {
        vscode.window.showInformationMessage(options.message);
    }
}

async function refreshViewsAfterClassificationChange(): Promise<void> {
    treeDataProvider.refresh();
    applyHighlightsToAllEditors();
    await saveCache();
}

function buildClassificationMessage(
    lineCount: number,
    selection: ClassificationSelection
): string {
    return `${lineCount}개 라인을 ${getCategoryLabel(selection.category)}(으)로 분류했습니다`
        + (selection.reason ? ` (${selection.reason})` : '');
}

function applyHighlightsToEditor(editor: vscode.TextEditor): void {
    if (!coverageData) {
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const coverage = findMatchingCoverage(filePath, coverageData.files);

    if (!coverage) {
        highlighter.clearHighlights(editor);
        return;
    }

    const adjustedCoverage = lineTracker.applyOffsetsToFile(filePath, coverage);
    lineTracker.registerFile(filePath, {
        coveredLines: adjustedCoverage.coveredLines,
        uncoveredLines: adjustedCoverage.uncoveredLines,
        partialCoveredLines: adjustedCoverage.partialCoveredLines
    });

    filePathMapping.set(filePath, coverage.fileName);
    highlighter.applyHighlights(editor, adjustedCoverage);
}

function applyHighlightsToEditorWithTracker(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const tracked = lineTracker.getTrackedLines(filePath);

    if (!tracked) {
        return;
    }

    const coverage: FileCoverage = {
        fileName: filePathMapping.get(filePath) || filePath,
        coveredLines: tracked.coveredLines,
        uncoveredLines: tracked.uncoveredLines,
        partialCoveredLines: tracked.partialCoveredLines
    };

    highlighter.applyHighlights(editor, coverage);
}

function applyHighlightsToAllEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
        applyHighlightsToEditor(editor);
    }
}

function updateStatusBar(): void {
    if (!coverageData) {
        statusBarItem.hide();
        return;
    }

    statusBarItem.text = `$(beaker) 커버리지: ${coverageData.summary.statementCov.toFixed(1)}%`;
    statusBarItem.tooltip =
        `구문: ${coverageData.summary.statementCov.toFixed(1)}% | `
        + `분기: ${coverageData.summary.branchCov.toFixed(1)}%\n클릭하여 요약 보기`;
    statusBarItem.show();
}

export function deactivate(): void {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }

    if (highlighter) {
        highlighter.dispose();
    }

    if (lineTracker) {
        void saveCache();
        lineTracker.clear();
    }
}
