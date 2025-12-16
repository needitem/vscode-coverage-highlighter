import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs';

export interface FunctionCoverage {
    fileName: string;
    functionName: string;
    functionStartLine: number;
    functionEndLine: number;
    statementCov: number;
    branchCov: number;
    coveredStatementList: number[];
    uncoveredStatementList: number[];
    partialCoveredStatementList: number[];
}

export interface FileCoverage {
    fileName: string;
    coveredLines: Set<number>;
    uncoveredLines: Set<number>;
    partialCoveredLines: Set<number>;
}

export interface CoverageSummary {
    statementCov: number;
    branchCov: number;
    mcdcCov: number;
}

export interface CoverageData {
    summary: CoverageSummary;
    files: Map<string, FileCoverage>;
}

function parseLineList(value: string | number | undefined): number[] {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    const str = String(value);
    if (str.trim() === '') {
        return [];
    }
    return str.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

export function parseCoverageXml(xmlPath: string): CoverageData {
    const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
    return parseCoverageXmlContent(xmlContent);
}

// 비동기 버전 - 대용량 파일에 권장
export async function parseCoverageXmlAsync(xmlPath: string): Promise<CoverageData> {
    const xmlContent = await fs.promises.readFile(xmlPath, 'utf-8');
    return parseCoverageXmlContent(xmlContent);
}

function parseCoverageXmlContent(xmlContent: string): CoverageData {
    const parser = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: true,
        trimValues: true
    });

    const parsed = parser.parse(xmlContent);
    const root = parsed['cv.CoverResult'];

    if (!root) {
        throw new Error('Invalid coverage XML format: missing cv.CoverResult root element');
    }

    // Parse summary
    const summaryData = root.summary || {};
    const summary: CoverageSummary = {
        statementCov: parseFloat(summaryData.statementCov) || 0,
        branchCov: parseFloat(summaryData.branchCov) || 0,
        mcdcCov: parseFloat(summaryData.mcdcCov) || -1
    };

    // Parse function coverages
    const files = new Map<string, FileCoverage>();

    let functionCoverages = root.functionCoverage;
    if (!functionCoverages) {
        return { summary, files };
    }

    // Ensure it's an array
    if (!Array.isArray(functionCoverages)) {
        functionCoverages = [functionCoverages];
    }

    for (const fc of functionCoverages) {
        const fileName = fc.fileName;
        if (!fileName) continue;

        // Get or create file coverage
        let fileCov = files.get(fileName);
        if (!fileCov) {
            fileCov = {
                fileName,
                coveredLines: new Set<number>(),
                uncoveredLines: new Set<number>(),
                partialCoveredLines: new Set<number>()
            };
            files.set(fileName, fileCov);
        }

        // Parse covered lines
        const coveredLines = parseLineList(fc.coveredStatementList);
        for (const line of coveredLines) {
            fileCov.coveredLines.add(line);
        }

        // Parse uncovered lines
        const uncoveredLines = parseLineList(fc.unCoveredStatementList);
        for (const line of uncoveredLines) {
            fileCov.uncoveredLines.add(line);
        }

        // Parse partial covered lines
        const partialLines = parseLineList(fc.partialCoveredStatementList);
        for (const line of partialLines) {
            fileCov.partialCoveredLines.add(line);
        }
    }

    return { summary, files };
}

// Normalize path separators for comparison
export function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}

// Extract relative path parts for matching
export function getPathSuffix(filePath: string, depth: number = 5): string {
    const normalized = normalizePath(filePath);
    const parts = normalized.split('/').filter(p => p.length > 0);
    return parts.slice(-depth).join('/');
}

// Find matching file in coverage data
export function findMatchingCoverage(
    localFilePath: string,
    coverageFiles: Map<string, FileCoverage>,
    matchDepth: number = 5
): FileCoverage | undefined {
    const localSuffix = getPathSuffix(localFilePath, matchDepth);

    for (const [covPath, coverage] of coverageFiles) {
        const covSuffix = getPathSuffix(covPath, matchDepth);
        if (localSuffix === covSuffix) {
            return coverage;
        }
    }

    // Try with shorter match if not found
    if (matchDepth > 2) {
        return findMatchingCoverage(localFilePath, coverageFiles, matchDepth - 1);
    }

    return undefined;
}

// 파일 경로 캐시 (coverage path -> local path)
const filePathCache: Map<string, string | null> = new Map();

// Find local file path matching coverage file path in workspace (동기 버전 - 캐시된 결과만 반환)
export function findLocalFilePath(
    coverageFilePath: string,
    _workspaceRoot?: string,
    _matchDepth?: number
): string | undefined {
    const cached = filePathCache.get(coverageFilePath);
    if (cached !== undefined) {
        return cached || undefined;
    }
    return undefined;
}

// Find local file path matching coverage file path in workspace (비동기 버전 - VSCode API 사용)
export async function findLocalFilePathAsync(
    coverageFilePath: string,
    matchDepth: number = 5
): Promise<string | undefined> {
    // 캐시 확인
    const cached = filePathCache.get(coverageFilePath);
    if (cached !== undefined) {
        return cached || undefined;
    }

    const covSuffix = getPathSuffix(coverageFilePath, matchDepth);
    const fileName = coverageFilePath.split(/[/\\]/).pop() || '';

    if (!fileName) {
        filePathCache.set(coverageFilePath, null);
        return undefined;
    }

    try {
        // VSCode의 findFiles API 사용 - 훨씬 빠르고 비동기
        const vscode = await import('vscode');
        const files = await vscode.workspace.findFiles(
            `**/${fileName}`,
            '**/node_modules/**',
            10 // 최대 10개까지만 검색
        );

        for (const file of files) {
            const localSuffix = getPathSuffix(file.fsPath, matchDepth);
            if (localSuffix === covSuffix) {
                filePathCache.set(coverageFilePath, file.fsPath);
                return file.fsPath;
            }
        }

        // 더 짧은 매칭 시도
        if (matchDepth > 2) {
            const result = await findLocalFilePathAsync(coverageFilePath, matchDepth - 1);
            return result;
        }

        filePathCache.set(coverageFilePath, null);
        return undefined;
    } catch {
        filePathCache.set(coverageFilePath, null);
        return undefined;
    }
}

// 캐시 초기화
export function clearFilePathCache(): void {
    filePathCache.clear();
}
