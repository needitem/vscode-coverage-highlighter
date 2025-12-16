import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseCoverageXml, findMatchingCoverage, findLocalFilePathAsync, CoverageData, FileCoverage } from './coverageParser';
import { CoverageHighlighter } from './highlighter';
import { LineTracker } from './lineTracker';
import { ClassificationManager } from './classificationManager';
import { CoverageTreeDataProvider } from './coverageTreeView';

let coverageData: CoverageData | undefined;
let highlighter: CoverageHighlighter;
let lineTracker: LineTracker;
let classificationManager: ClassificationManager;
let treeDataProvider: CoverageTreeDataProvider;
let statusBarItem: vscode.StatusBarItem;

// 파일 경로 매핑 캐시 (로컬 경로 -> coverage 파일 경로)
const filePathMapping: Map<string, string> = new Map();

// 워크스페이스 캐시 파일 경로
function getCacheFilePath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'coverage-cache.json');
}

// 캐시 데이터 인터페이스
interface CacheData {
    xmlPath?: string;
    recentXmlFiles?: string[];  // 최근 로드한 XML 파일 목록
    lineOffsets: { [filePath: string]: { [originalLine: number]: number } };
    classifications: [string, any[]][];
    reasons: { id: string; label: string }[];
}

// 최근 XML 파일 목록 (최대 10개)
let recentXmlFiles: string[] = [];
const MAX_RECENT_FILES = 10;

// 현재 로드된 XML 경로
let currentXmlPath: string | undefined;

// 캐시 저장
async function saveCache(): Promise<void> {
    const cachePath = getCacheFilePath();
    if (!cachePath) return;

    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    const lineOffsets: { [filePath: string]: { [originalLine: number]: number } } = {};

    // LineTracker에서 오프셋 정보 추출
    const trackerData = lineTracker.exportOffsets();
    for (const [filePath, offsets] of trackerData) {
        lineOffsets[filePath] = Object.fromEntries(offsets);
    }

    const cache: CacheData = {
        xmlPath: currentXmlPath,
        recentXmlFiles,
        lineOffsets,
        classifications: Array.from(classificationManager.getAllClassifications().entries()),
        reasons: classificationManager.getReasons()
    };

    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
}

// 캐시 로드
function loadCache(): CacheData | undefined {
    const cachePath = getCacheFilePath();
    if (!cachePath || !fs.existsSync(cachePath)) {
        return undefined;
    }

    try {
        const content = fs.readFileSync(cachePath, 'utf-8');
        return JSON.parse(content) as CacheData;
    } catch {
        return undefined;
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Coverage Highlighter is now active!');

    highlighter = new CoverageHighlighter();
    lineTracker = new LineTracker();
    classificationManager = new ClassificationManager(context);

    // highlighter에 classificationManager 연결
    highlighter.setClassificationManager(classificationManager);

    // TreeView 등록 - 다중 선택 활성화
    treeDataProvider = new CoverageTreeDataProvider(classificationManager);
    treeDataProvider.setLineTracker(lineTracker);
    const treeView = vscode.window.createTreeView('coverageExplorer', {
        treeDataProvider: treeDataProvider,
        canSelectMany: true  // Shift+클릭, Ctrl+클릭으로 다중 선택 가능
    });
    treeDataProvider.setTreeView(treeView);
    context.subscriptions.push(treeView);

    // 캐시 로드
    const cache = loadCache();
    if (cache) {
        lineTracker.importOffsets(cache.lineOffsets);
        if (cache.recentXmlFiles) {
            recentXmlFiles = cache.recentXmlFiles.filter(f => fs.existsSync(f));
        }
        if (cache.xmlPath && fs.existsSync(cache.xmlPath)) {
            currentXmlPath = cache.xmlPath;
        }
    }

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'coverage-highlighter.showSummary';
    context.subscriptions.push(statusBarItem);

    // Register commands
    const loadCommand = vscode.commands.registerCommand('coverage-highlighter.loadCoverage', async () => {
        await loadCoverage();
    });

    const refreshTreeCommand = vscode.commands.registerCommand('coverage-highlighter.refreshTree', () => {
        treeDataProvider.refresh();
    });

    const goToLineCommand = vscode.commands.registerCommand('coverage-highlighter.goToLine', async (filePath: string, line: number) => {
        let targetPath = filePath;

        // 파일이 존재하지 않으면 workspace에서 매칭되는 파일 찾기
        if (!fs.existsSync(filePath)) {
            const localPath = await findLocalFilePathAsync(filePath);
            if (localPath) {
                targetPath = localPath;
            } else {
                vscode.window.showWarningMessage(`파일을 찾을 수 없습니다: ${path.basename(filePath)}`);
                return;
            }
        }

        try {
            const doc = await vscode.workspace.openTextDocument(targetPath);
            const editor = await vscode.window.showTextDocument(doc);
            const position = new vscode.Position(line - 1, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        } catch (err) {
            vscode.window.showWarningMessage(`파일을 열 수 없습니다: ${path.basename(targetPath)}`);
        }
    });

    const clearCommand = vscode.commands.registerCommand('coverage-highlighter.clearCoverage', () => {
        clearCoverage();
    });

    const summaryCommand = vscode.commands.registerCommand('coverage-highlighter.showSummary', () => {
        showSummary();
    });

    const classifyLineCommand = vscode.commands.registerCommand('coverage-highlighter.classifyLine', async () => {
        await classifyCurrentLine();
    });

    const classifySelectionCommand = vscode.commands.registerCommand('coverage-highlighter.classifySelection', async () => {
        await classifySelectedLines();
    });

    const manageReasonsCommand = vscode.commands.registerCommand('coverage-highlighter.manageReasons', async () => {
        await manageReasons();
    });

    const generateReportCommand = vscode.commands.registerCommand('coverage-highlighter.generateReport', async () => {
        await generateReport();
    });

    const showClassificationsCommand = vscode.commands.registerCommand('coverage-highlighter.showClassifications', async () => {
        await showClassifications();
    });

    const removeClassificationCommand = vscode.commands.registerCommand('coverage-highlighter.removeClassification', async (item: any) => {
        if (item && item.filePath && item.line) {
            await classificationManager.removeClassification(item.filePath, item.line);
            treeDataProvider.refresh();
            await saveCache();
            vscode.window.showInformationMessage(`Line ${item.line} 분류가 제거되었습니다.`);
        }
    });

    // 빠른 분류 명령들 (단축키용) - 설정에서 슬롯 정보 읽음
    const quickClassifyDocumentCommand = vscode.commands.registerCommand('coverage-highlighter.quickClassifyDocument', async () => {
        await executeQuickSlot(1);
    });

    const quickClassifyCommentCommand = vscode.commands.registerCommand('coverage-highlighter.quickClassifyComment', async () => {
        await executeQuickSlot(2);
    });

    const quickClassifyCoverCommand = vscode.commands.registerCommand('coverage-highlighter.quickClassifyCover', async () => {
        await executeQuickSlot(3);
    });

    // 슬롯 4~9
    const quickSlot4Command = vscode.commands.registerCommand('coverage-highlighter.quickSlot4', () => executeQuickSlot(4));
    const quickSlot5Command = vscode.commands.registerCommand('coverage-highlighter.quickSlot5', () => executeQuickSlot(5));
    const quickSlot6Command = vscode.commands.registerCommand('coverage-highlighter.quickSlot6', () => executeQuickSlot(6));
    const quickSlot7Command = vscode.commands.registerCommand('coverage-highlighter.quickSlot7', () => executeQuickSlot(7));
    const quickSlot8Command = vscode.commands.registerCommand('coverage-highlighter.quickSlot8', () => executeQuickSlot(8));
    const quickSlot9Command = vscode.commands.registerCommand('coverage-highlighter.quickSlot9', () => executeQuickSlot(9));

    // TreeView에서 미분류 항목 분류 (기존 - 유지)
    const classifyFromTreeCommand = vscode.commands.registerCommand('coverage-highlighter.classifyFromTree', async (item: any) => {
        if (item && item.filePath && item.line) {
            await classifyLinesFromTree(item.filePath, item.line);
        }
    });

    // TreeView에서 빠른 분류 - 문서 (사유 선택)
    const quickClassifyFromTreeDocumentCommand = vscode.commands.registerCommand('coverage-highlighter.quickClassifyFromTreeDocument', async (item: any) => {
        if (item && item.filePath && item.line) {
            await quickClassifyFromTreeWithCategory(item.filePath, item.line, 'document');
        }
    });

    // TreeView에서 빠른 분류 - 주석예정
    const quickClassifyFromTreeCommentCommand = vscode.commands.registerCommand('coverage-highlighter.quickClassifyFromTreeComment', async (item: any) => {
        if (item && item.filePath && item.line) {
            await quickClassifyFromTreeDirect(item.filePath, item.line, 'comment-planned');
        }
    });

    // TreeView에서 빠른 분류 - 태울예정
    const quickClassifyFromTreeCoverCommand = vscode.commands.registerCommand('coverage-highlighter.quickClassifyFromTreeCover', async (item: any) => {
        if (item && item.filePath && item.line) {
            await quickClassifyFromTreeDirect(item.filePath, item.line, 'cover-planned');
        }
    });

    // 분류된 항목 하이라이트 토글
    const toggleHideClassifiedCommand = vscode.commands.registerCommand('coverage-highlighter.toggleHideClassified', () => {
        const current = highlighter.getHideClassified();
        highlighter.setHideClassified(!current);
        applyHighlightsToAllEditors();
        treeDataProvider.setHideClassified(!current);
        treeDataProvider.refresh();
        vscode.window.showInformationMessage(`분류된 항목 숨기기: ${!current ? 'ON' : 'OFF'}`);
    });

    // 최근 XML 직접 로드
    const loadRecentXmlCommand = vscode.commands.registerCommand('coverage-highlighter.loadRecentXml', async (xmlPath: string) => {
        await loadXmlFile(xmlPath);
    });

    // TreeView에서 사유와 함께 분류 (classify-option 클릭 시)
    const classifyFromTreeWithReasonCommand = vscode.commands.registerCommand('coverage-highlighter.classifyFromTreeWithReason',
        async (filePath: string, line: number, category: 'document' | 'comment-planned' | 'cover-planned', reason: string, lines?: number[]) => {
            const targetLines = lines && lines.length > 0 ? lines : [line];
            
            let finalReason = reason;
            if (reason === '__new__') {
                const newReason = await vscode.window.showInputBox({
                    prompt: '새 사유를 입력하세요',
                    placeHolder: '예: UI 관련 코드'
                });
                if (!newReason) return;
                await classificationManager.addReason(newReason);
                finalReason = newReason;
            }

            await classificationManager.classifyLines(filePath, targetLines, category, finalReason);
            
            for (const l of targetLines) {
                treeDataProvider.hideClassifiedLine(filePath, l);
            }
            
            // 분류된 항목 숨기기 모드일 때 하이라이트 즉시 반영
            applyHighlightsToAllEditors();
            
            await saveCache();
            
            const categoryLabel = category === 'document' ? '문서' : category === 'comment-planned' ? '주석예정' : '태울예정';
            const msg = finalReason ? `${targetLines.length}개 라인 → ${categoryLabel} (${finalReason})` : `${targetLines.length}개 라인 → ${categoryLabel}`;
            vscode.window.showInformationMessage(msg);
        }
    );

    // 일괄 분류 (다중 선택된 미분류 항목)
    const bulkClassifyCommand = vscode.commands.registerCommand('coverage-highlighter.bulkClassify', async (...args: any[]) => {
        const selectedItems = treeDataProvider.getTreeView()?.selection || [];
        const unclassifiedItems = selectedItems.filter((item: any) => item.type === 'unclassified-line' && item.filePath && item.lines);
        
        if (unclassifiedItems.length === 0) {
            vscode.window.showWarningMessage('분류할 항목을 선택하세요.');
            return;
        }

        // 카테고리 선택
        const categoryChoice = await vscode.window.showQuickPick([
            { label: '문서', value: 'document' as const },
            { label: '주석 예정', value: 'comment-planned' as const },
            { label: '태울 예정', value: 'cover-planned' as const }
        ], { placeHolder: '분류 카테고리를 선택하세요' });

        if (!categoryChoice) return;

        let reasonLabel = '';
        if (categoryChoice.value === 'document') {
            const reasons = classificationManager.getReasons();
            const reasonItems = [
                ...reasons.map(r => ({ label: r.label, value: r.label })),
                { label: '$(add) 새 사유 추가...', value: '__new__' }
            ];

            const reasonChoice = await vscode.window.showQuickPick(reasonItems, { placeHolder: '사유를 선택하세요' });
            if (!reasonChoice) return;

            if (reasonChoice.value === '__new__') {
                const newReason = await vscode.window.showInputBox({ prompt: '새 사유를 입력하세요' });
                if (!newReason) return;
                await classificationManager.addReason(newReason);
                reasonLabel = newReason;
            } else {
                reasonLabel = reasonChoice.value;
            }
        }

        let totalLines = 0;
        for (const item of unclassifiedItems) {
            const lines = (item.lines || [item.line]) as number[];
            await classificationManager.classifyLines(item.filePath!, lines, categoryChoice.value, reasonLabel);
            totalLines += lines.length;
        }

        treeDataProvider.refresh();
        applyHighlightsToAllEditors();
        await saveCache();

        const categoryLabel = categoryChoice.value === 'document' ? '문서' : categoryChoice.value === 'comment-planned' ? '주석예정' : '태울예정';
        vscode.window.showInformationMessage(`${totalLines}개 라인 → ${categoryLabel}`);
    });

    // 일괄 삭제 (다중 선택된 분류 항목)
    const bulkRemoveClassificationCommand = vscode.commands.registerCommand('coverage-highlighter.bulkRemoveClassification', async () => {
        const selectedItems = treeDataProvider.getTreeView()?.selection || [];
        const classifiedItems = selectedItems.filter((item: any) => item.type === 'line' && item.filePath && item.line && item.category);
        
        if (classifiedItems.length === 0) {
            vscode.window.showWarningMessage('삭제할 분류 항목을 선택하세요.');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `${classifiedItems.length}개 항목의 분류를 삭제하시겠습니까?`,
            '삭제', '취소'
        );
        if (confirm !== '삭제') return;

        for (const item of classifiedItems) {
            await classificationManager.removeClassification(item.filePath!, item.line!);
        }

        treeDataProvider.refresh();
        applyHighlightsToAllEditors();
        await saveCache();
        vscode.window.showInformationMessage(`${classifiedItems.length}개 항목 분류 삭제됨`);
    });

    // 일괄 수정 (다중 선택된 분류 항목)
    const bulkEditClassificationCommand = vscode.commands.registerCommand('coverage-highlighter.bulkEditClassification', async () => {
        const selectedItems = treeDataProvider.getTreeView()?.selection || [];
        const classifiedItems = selectedItems.filter((item: any) => item.type === 'line' && item.filePath && item.line && item.category);
        
        if (classifiedItems.length === 0) {
            vscode.window.showWarningMessage('수정할 분류 항목을 선택하세요.');
            return;
        }

        // 새 카테고리 선택
        const categoryChoice = await vscode.window.showQuickPick([
            { label: '문서', value: 'document' as const },
            { label: '주석 예정', value: 'comment-planned' as const },
            { label: '태울 예정', value: 'cover-planned' as const }
        ], { placeHolder: '새 카테고리를 선택하세요' });

        if (!categoryChoice) return;

        let reasonLabel = '';
        if (categoryChoice.value === 'document') {
            const reasons = classificationManager.getReasons();
            const reasonItems = [
                ...reasons.map(r => ({ label: r.label, value: r.label })),
                { label: '$(add) 새 사유 추가...', value: '__new__' }
            ];

            const reasonChoice = await vscode.window.showQuickPick(reasonItems, { placeHolder: '사유를 선택하세요' });
            if (!reasonChoice) return;

            if (reasonChoice.value === '__new__') {
                const newReason = await vscode.window.showInputBox({ prompt: '새 사유를 입력하세요' });
                if (!newReason) return;
                await classificationManager.addReason(newReason);
                reasonLabel = newReason;
            } else {
                reasonLabel = reasonChoice.value;
            }
        }

        // 기존 분류 삭제 후 새로 분류
        for (const item of classifiedItems) {
            await classificationManager.removeClassification(item.filePath!, item.line!);
            await classificationManager.classifyLines(item.filePath!, [item.line!], categoryChoice.value, reasonLabel);
        }

        treeDataProvider.refresh();
        applyHighlightsToAllEditors();
        await saveCache();

        const categoryLabel = categoryChoice.value === 'document' ? '문서' : categoryChoice.value === 'comment-planned' ? '주석예정' : '태울예정';
        vscode.window.showInformationMessage(`${classifiedItems.length}개 항목 → ${categoryLabel}`);
    });

    // 단일 분류 수정
    const editClassificationCommand = vscode.commands.registerCommand('coverage-highlighter.editClassification', async (item: any) => {
        if (!item || !item.filePath || !item.line) {
            vscode.window.showWarningMessage('수정할 항목을 선택하세요.');
            return;
        }

        const categoryChoice = await vscode.window.showQuickPick([
            { label: '문서', value: 'document' as const },
            { label: '주석 예정', value: 'comment-planned' as const },
            { label: '태울 예정', value: 'cover-planned' as const }
        ], { placeHolder: '새 카테고리를 선택하세요' });

        if (!categoryChoice) return;

        let reasonLabel = '';
        if (categoryChoice.value === 'document') {
            const reasons = classificationManager.getReasons();
            const reasonItems = [
                ...reasons.map(r => ({ label: r.label, value: r.label })),
                { label: '$(add) 새 사유 추가...', value: '__new__' }
            ];

            const reasonChoice = await vscode.window.showQuickPick(reasonItems, { placeHolder: '사유를 선택하세요' });
            if (!reasonChoice) return;

            if (reasonChoice.value === '__new__') {
                const newReason = await vscode.window.showInputBox({ prompt: '새 사유를 입력하세요' });
                if (!newReason) return;
                await classificationManager.addReason(newReason);
                reasonLabel = newReason;
            } else {
                reasonLabel = reasonChoice.value;
            }
        }

        await classificationManager.removeClassification(item.filePath, item.line);
        await classificationManager.classifyLines(item.filePath, [item.line], categoryChoice.value, reasonLabel);

        treeDataProvider.refresh();
        applyHighlightsToAllEditors();
        await saveCache();

        const categoryLabel = categoryChoice.value === 'document' ? '문서' : categoryChoice.value === 'comment-planned' ? '주석예정' : '태울예정';
        vscode.window.showInformationMessage(`Line ${item.line} → ${categoryLabel}`);
    });

    context.subscriptions.push(
        loadCommand, clearCommand, summaryCommand,
        classifyLineCommand, classifySelectionCommand,
        manageReasonsCommand, generateReportCommand, showClassificationsCommand,
        refreshTreeCommand, goToLineCommand, removeClassificationCommand,
        quickClassifyDocumentCommand, quickClassifyCommentCommand, quickClassifyCoverCommand,
        quickSlot4Command, quickSlot5Command, quickSlot6Command,
        quickSlot7Command, quickSlot8Command, quickSlot9Command,
        classifyFromTreeCommand, loadRecentXmlCommand,
        quickClassifyFromTreeDocumentCommand, quickClassifyFromTreeCommentCommand, quickClassifyFromTreeCoverCommand,
        toggleHideClassifiedCommand, classifyFromTreeWithReasonCommand,
        bulkClassifyCommand, bulkRemoveClassificationCommand, bulkEditClassificationCommand, editClassificationCommand
    );

    // TreeView에 최근 파일 목록 전달
    treeDataProvider.setRecentXmlFiles(recentXmlFiles);
    if (currentXmlPath) {
        treeDataProvider.setCurrentXmlPath(currentXmlPath);
    }

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

                // 캐시 저장 (디바운스)
                debouncedSaveCache();
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
            saveCache();
        }
    });
}

// 디바운스된 캐시 저장
let saveTimeout: NodeJS.Timeout | undefined;
function debouncedSaveCache(): void {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
        saveCache();
    }, 2000);
}

// XML 파일을 최근 목록에 추가
function addToRecentFiles(xmlPath: string): void {
    // 이미 있으면 제거 후 맨 앞에 추가
    recentXmlFiles = recentXmlFiles.filter(f => f !== xmlPath);
    recentXmlFiles.unshift(xmlPath);
    // 최대 개수 유지
    if (recentXmlFiles.length > MAX_RECENT_FILES) {
        recentXmlFiles = recentXmlFiles.slice(0, MAX_RECENT_FILES);
    }
}

// 최근 파일 목록 가져오기
function getRecentXmlFiles(): { label: string; description: string; path: string }[] {
    return recentXmlFiles
        .filter(f => fs.existsSync(f))
        .map(f => ({
            label: path.basename(f),
            description: path.dirname(f),
            path: f
        }));
}

async function loadCoverage() {
    // 최근 파일이 있으면 선택 옵션 제공
    const recentFiles = getRecentXmlFiles();

    let xmlPath: string | undefined;

    if (recentFiles.length > 0) {
        const items: (vscode.QuickPickItem & { path?: string })[] = [
            { label: '$(folder-opened) 새 파일 선택...', description: '파일 탐색기에서 선택' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...recentFiles.map(f => ({
                label: `$(history) ${f.label}`,
                description: f.description,
                path: f.path
            }))
        ];

        // 현재 로드된 파일 표시
        if (currentXmlPath) {
            const currentIdx = items.findIndex(i => i.path === currentXmlPath);
            if (currentIdx >= 0) {
                items[currentIdx].label = items[currentIdx].label.replace('$(history)', '$(check)');
                items[currentIdx].description += ' (현재)';
            }
        }

        const choice = await vscode.window.showQuickPick(items, {
            placeHolder: 'Coverage XML 파일 선택',
            title: 'Coverage XML 로드'
        });

        if (!choice) return;

        if (choice.path) {
            xmlPath = choice.path;
        } else {
            // 새 파일 선택
            const files = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'Coverage XML': ['xml'] },
                title: 'Select Coverage XML File'
            });
            if (!files || files.length === 0) return;
            xmlPath = files[0].fsPath;
        }
    } else {
        // 최근 파일 없으면 바로 파일 선택
        const files = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Coverage XML': ['xml'] },
            title: 'Select Coverage XML File'
        });
        if (!files || files.length === 0) return;
        xmlPath = files[0].fsPath;
    }

    await loadXmlFile(xmlPath);
}

// XML 파일 직접 로드
async function loadXmlFile(xmlPath: string) {
    if (!fs.existsSync(xmlPath)) {
        vscode.window.showErrorMessage(`파일을 찾을 수 없습니다: ${xmlPath}`);
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Loading coverage data...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Parsing XML..." });

            // 이전 데이터 초기화 (캐시된 오프셋은 유지)
            filePathMapping.clear();

            coverageData = parseCoverageXml(xmlPath);
            currentXmlPath = xmlPath;
            addToRecentFiles(xmlPath);

            progress.report({ increment: 50, message: "Applying highlights..." });

            // Update status bar
            updateStatusBar();

            // Apply highlights to all visible editors
            applyHighlightsToAllEditors();

            // TreeView 업데이트
            treeDataProvider.setCoverageData(coverageData);
            treeDataProvider.setCurrentXmlPath(currentXmlPath);
            treeDataProvider.setRecentXmlFiles(recentXmlFiles);

            // 캐시 저장
            await saveCache();

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

async function classifyCurrentLine() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const line = editor.selection.active.line + 1; // 1-based
    const filePath = editor.document.uri.fsPath;

    // 연속된 uncovered 블록 자동 선택
    const blockLines = lineTracker.getUncoveredBlock(filePath, line);

    await classifyLines(filePath, blockLines);
}

async function classifySelectedLines() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const selection = editor.selection;
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const filePath = editor.document.uri.fsPath;

    // 선택된 범위의 모든 라인에 대해 연속 블록 확장
    const allBlockLines = new Set<number>();
    for (let i = startLine; i <= endLine; i++) {
        const blockLines = lineTracker.getUncoveredBlock(filePath, i);
        blockLines.forEach(line => allBlockLines.add(line));
    }

    const sortedLines = Array.from(allBlockLines).sort((a, b) => a - b);
    await classifyLines(filePath, sortedLines);
}

async function classifyLines(filePath: string, lines: number[]) {
    // 카테고리 선택
    const categoryChoice = await vscode.window.showQuickPick([
        { label: '문서', value: 'document' as const, description: '문서화 대상 (보고서에 포함)' },
        { label: '주석 예정', value: 'comment-planned' as const, description: '주석 처리 예정' },
        { label: '태울 예정', value: 'cover-planned' as const, description: '커버리지 달성 예정' }
    ], {
        placeHolder: '분류 카테고리를 선택하세요'
    });

    if (!categoryChoice) return;

    let reasonLabel: string;

    // 문서 카테고리만 사유 선택 필요
    if (categoryChoice.value === 'document') {
        const reasons = classificationManager.getReasons();
        const reasonItems = [
            ...reasons.map(r => ({ label: r.label, value: r.id })),
            { label: '$(add) 새 사유 추가...', value: '__new__' }
        ];

        const reasonChoice = await vscode.window.showQuickPick(reasonItems, {
            placeHolder: '사유를 선택하세요'
        });

        if (!reasonChoice) return;

        if (reasonChoice.value === '__new__') {
            const newReason = await vscode.window.showInputBox({
                prompt: '새 사유를 입력하세요',
                placeHolder: '예: UI 관련 코드'
            });
            if (!newReason) return;

            await classificationManager.addReason(newReason);
            reasonLabel = newReason;
        } else {
            reasonLabel = reasonChoice.label;
        }
    } else {
        // 주석 예정, 태울 예정은 사유 없이 바로 분류
        reasonLabel = '';
    }

    // 분류 저장
    await classificationManager.classifyLines(filePath, lines, categoryChoice.value, reasonLabel);

    const message = reasonLabel
        ? `${lines.length}개 라인이 "${categoryChoice.label} - ${reasonLabel}"로 분류되었습니다.`
        : `${lines.length}개 라인이 "${categoryChoice.label}"로 분류되었습니다.`;
    vscode.window.showInformationMessage(message);

    // TreeView 갱신
    treeDataProvider.refresh();

    // 캐시 저장
    await saveCache();
}

// 슬롯 기반 빠른 분류 실행
async function executeQuickSlot(slotNumber: number) {
    const config = vscode.workspace.getConfiguration('coverageHighlighter');
    const slotConfig = config.get<{ category: string; reason?: string }>(`quickSlot${slotNumber}`);

    if (!slotConfig || !slotConfig.category) {
        vscode.window.showWarningMessage(`슬롯 ${slotNumber}이 설정되지 않았습니다. 설정에서 coverageHighlighter.quickSlot${slotNumber}을 설정하세요.`);
        return;
    }

    const category = slotConfig.category as 'document' | 'comment-planned' | 'cover-planned';
    const reason = slotConfig.reason || '';

    // 문서 카테고리인데 사유가 없으면 선택하도록
    if (category === 'document' && !reason) {
        await quickClassifyWithReasonPrompt(category);
    } else {
        await quickClassifyDirect(category, reason);
    }
}

// 사유 프롬프트와 함께 빠른 분류
async function quickClassifyWithReasonPrompt(category: 'document' | 'comment-planned' | 'cover-planned') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const line = editor.selection.active.line + 1;
    const filePath = editor.document.uri.fsPath;
    const blockLines = lineTracker.getUncoveredBlock(filePath, line);

    let reasonLabel = '';

    if (category === 'document') {
        const reasons = classificationManager.getReasons();
        if (reasons.length === 0) {
            const newReason = await vscode.window.showInputBox({
                prompt: '사유를 입력하세요',
                placeHolder: '예: UI 관련 코드'
            });
            if (!newReason) return;
            await classificationManager.addReason(newReason);
            reasonLabel = newReason;
        } else {
            const reasonChoice = await vscode.window.showQuickPick(
                reasons.map(r => r.label),
                { placeHolder: '사유를 선택하세요' }
            );
            if (!reasonChoice) return;
            reasonLabel = reasonChoice;
        }
    }

    await classificationManager.classifyLines(filePath, blockLines, category, reasonLabel);

    const categoryLabel = category === 'document' ? '문서' : category === 'comment-planned' ? '주석예정' : '태울예정';
    vscode.window.showInformationMessage(`${blockLines.length}개 라인 → ${categoryLabel}`);

    treeDataProvider.refresh();
    await saveCache();
}

// 다이얼로그 없이 직접 분류
async function quickClassifyDirect(category: 'document' | 'comment-planned' | 'cover-planned', reason: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }

    const line = editor.selection.active.line + 1;
    const filePath = editor.document.uri.fsPath;
    const blockLines = lineTracker.getUncoveredBlock(filePath, line);

    await classificationManager.classifyLines(filePath, blockLines, category, reason);

    const categoryLabel = category === 'document' ? '문서' : category === 'comment-planned' ? '주석예정' : '태울예정';
    const msg = reason ? `${blockLines.length}개 라인 → ${categoryLabel} (${reason})` : `${blockLines.length}개 라인 → ${categoryLabel}`;
    vscode.window.showInformationMessage(msg);

    treeDataProvider.refresh();
    await saveCache();
}

// TreeView에서 미분류 항목 분류
async function classifyLinesFromTree(filePath: string, startLine: number) {
    // 해당 라인이 포함된 블록 찾기 (coverage 데이터에서)
    const lines = [startLine]; // TreeView에서는 블록 시작 라인만 전달됨

    await classifyLines(filePath, lines);
}

// TreeView에서 빠른 분류 - 사유 선택 필요한 경우 (문서)
async function quickClassifyFromTreeWithCategory(filePath: string, startLine: number, category: 'document' | 'comment-planned' | 'cover-planned') {
    const lines = [startLine];

    let reasonLabel = '';

    if (category === 'document') {
        const reasons = classificationManager.getReasons();
        const reasonItems = [
            ...reasons.map(r => ({ label: r.label, value: r.label })),
            { label: '$(add) 새 사유 추가...', value: '__new__' }
        ];

        if (reasonItems.length === 1) {
            // 사유가 없으면 바로 입력
            const newReason = await vscode.window.showInputBox({
                prompt: '사유를 입력하세요',
                placeHolder: '예: UI 관련 코드'
            });
            if (!newReason) return;
            await classificationManager.addReason(newReason);
            reasonLabel = newReason;
        } else {
            const reasonChoice = await vscode.window.showQuickPick(reasonItems, {
                placeHolder: '사유를 선택하세요'
            });
            if (!reasonChoice) return;

            if (reasonChoice.value === '__new__') {
                const newReason = await vscode.window.showInputBox({
                    prompt: '새 사유를 입력하세요',
                    placeHolder: '예: UI 관련 코드'
                });
                if (!newReason) return;
                await classificationManager.addReason(newReason);
                reasonLabel = newReason;
            } else {
                reasonLabel = reasonChoice.value;
            }
        }
    }

    await classificationManager.classifyLines(filePath, lines, category, reasonLabel);

    const categoryLabel = category === 'document' ? '문서' : category === 'comment-planned' ? '주석예정' : '태울예정';
    const msg = reasonLabel ? `Line ${startLine} → ${categoryLabel} (${reasonLabel})` : `Line ${startLine} → ${categoryLabel}`;
    vscode.window.showInformationMessage(msg);

    treeDataProvider.hideClassifiedLine(filePath, startLine);
    applyHighlightsToAllEditors();
    await saveCache();
}

// TreeView에서 빠른 분류 - 사유 없이 바로 분류 (주석예정, 태울예정)
async function quickClassifyFromTreeDirect(filePath: string, startLine: number, category: 'document' | 'comment-planned' | 'cover-planned') {
    const lines = [startLine];

    await classificationManager.classifyLines(filePath, lines, category, '');

    const categoryLabel = category === 'document' ? '문서' : category === 'comment-planned' ? '주석예정' : '태울예정';
    vscode.window.showInformationMessage(`Line ${startLine} → ${categoryLabel}`);

    treeDataProvider.hideClassifiedLine(filePath, startLine);
    applyHighlightsToAllEditors();
    await saveCache();
}

async function manageReasons() {
    const reasons = classificationManager.getReasons();

    const items = [
        { label: '$(add) 새 사유 추가', value: '__add__' },
        ...reasons.map(r => ({ label: `$(trash) ${r.label}`, value: r.id, description: '삭제하려면 선택' }))
    ];

    const choice = await vscode.window.showQuickPick(items, {
        placeHolder: '사유 관리'
    });

    if (!choice) return;

    if (choice.value === '__add__') {
        const newReason = await vscode.window.showInputBox({
            prompt: '새 사유를 입력하세요',
            placeHolder: '예: UI 관련 코드'
        });
        if (newReason) {
            await classificationManager.addReason(newReason);
            vscode.window.showInformationMessage(`사유 "${newReason}"이(가) 추가되었습니다.`);
        }
    } else {
        const confirm = await vscode.window.showWarningMessage(
            `"${choice.label.replace('$(trash) ', '')}" 사유를 삭제하시겠습니까?`,
            '삭제', '취소'
        );
        if (confirm === '삭제') {
            await classificationManager.removeReason(choice.value);
            vscode.window.showInformationMessage('사유가 삭제되었습니다.');
        }
    }
}

async function generateReport() {
    const reportType = await vscode.window.showQuickPick([
        { label: '문서용 보고서', value: 'document' },
        { label: '전체 보고서', value: 'full' }
    ], {
        placeHolder: '보고서 유형을 선택하세요'
    });

    if (!reportType) return;

    let report: string;
    if (reportType.value === 'document') {
        report = classificationManager.generateDocumentReport();
    } else {
        report = classificationManager.generateFullReport();
    }

    // 새 문서에 보고서 표시
    const doc = await vscode.workspace.openTextDocument({
        content: report,
        language: 'markdown'
    });
    await vscode.window.showTextDocument(doc);
}

async function showClassifications() {
    const panel = vscode.window.createWebviewPanel(
        'coverageClassifications',
        'Coverage Classifications',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    const classifications = classificationManager.getAllClassifications();

    let tableHtml = '';
    for (const [key, items] of classifications.entries()) {
        const [category, reason] = key.split(':');
        const categoryLabel = category === 'document' ? '문서' : category === 'comment-planned' ? '주석 예정' : '태울 예정';

        // 파일별 그룹화
        const byFile = new Map<string, number[]>();
        for (const item of items) {
            if (!byFile.has(item.fileName)) {
                byFile.set(item.fileName, []);
            }
            byFile.get(item.fileName)!.push(item.line);
        }

        tableHtml += `<h3>${categoryLabel} - ${reason}</h3>`;
        tableHtml += `<table>
            <thead><tr><th>번호</th><th>파일명</th><th>코드위치</th><th>비고</th></tr></thead>
            <tbody>`;

        let index = 1;
        for (const [fileName, lines] of byFile.entries()) {
            lines.sort((a, b) => a - b);
            tableHtml += `<tr>
                <td>${index}</td>
                <td>${fileName}</td>
                <td>${lines.join(' ')}</td>
                <td></td>
            </tr>`;
            index++;
        }

        tableHtml += `</tbody></table>`;
    }

    if (tableHtml === '') {
        tableHtml = '<p>분류된 항목이 없습니다.</p>';
    }

    panel.webview.html = `
        <!DOCTYPE html>
        <html lang="ko">
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
            <h1>분류된 미달성 코드</h1>
            ${tableHtml}
        </body>
        </html>
    `;
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
        // 캐시된 오프셋 적용
        const adjustedCoverage = lineTracker.applyOffsetsToFile(filePath, coverage);

        // LineTracker에 등록
        lineTracker.registerFile(filePath, {
            coveredLines: adjustedCoverage.coveredLines,
            uncoveredLines: adjustedCoverage.uncoveredLines,
            partialCoveredLines: adjustedCoverage.partialCoveredLines
        });

        // 경로 매핑 저장
        filePathMapping.set(filePath, coverage.fileName);

        highlighter.applyHighlights(editor, adjustedCoverage);
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
        saveCache();
        lineTracker.clear();
    }
}
