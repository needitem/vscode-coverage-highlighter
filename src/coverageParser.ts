import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { getPathSuffix, normalizePath } from './pathUtils';

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

    return str
        .split(',')
        .map(segment => parseInt(segment.trim(), 10))
        .filter(line => !Number.isNaN(line));
}

export function parseCoverageXml(xmlPath: string): CoverageData {
    const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
    return parseCoverageXmlContent(xmlContent);
}

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

    const summaryData = root.summary || {};
    const summary: CoverageSummary = {
        statementCov: parseFloat(summaryData.statementCov) || 0,
        branchCov: parseFloat(summaryData.branchCov) || 0,
        mcdcCov: parseFloat(summaryData.mcdcCov) || -1
    };

    const files = new Map<string, FileCoverage>();
    let functionCoverages = root.functionCoverage;

    if (!functionCoverages) {
        return { summary, files };
    }

    if (!Array.isArray(functionCoverages)) {
        functionCoverages = [functionCoverages];
    }

    for (const functionCoverage of functionCoverages) {
        const fileName = functionCoverage.fileName;
        if (!fileName) {
            continue;
        }

        const fileCoverage = files.get(fileName) ?? {
            fileName,
            coveredLines: new Set<number>(),
            uncoveredLines: new Set<number>(),
            partialCoveredLines: new Set<number>()
        };

        files.set(fileName, fileCoverage);

        for (const line of parseLineList(functionCoverage.coveredStatementList)) {
            fileCoverage.coveredLines.add(line);
        }

        for (const line of parseLineList(functionCoverage.unCoveredStatementList)) {
            fileCoverage.uncoveredLines.add(line);
        }

        for (const line of parseLineList(functionCoverage.partialCoveredStatementList)) {
            fileCoverage.partialCoveredLines.add(line);
        }
    }

    return { summary, files };
}

export { getPathSuffix, normalizePath };

export function findMatchingCoverage(
    localFilePath: string,
    coverageFiles: Map<string, FileCoverage>,
    matchDepth: number = 5
): FileCoverage | undefined {
    const localSuffix = getPathSuffix(localFilePath, matchDepth);

    for (const [coveragePath, coverage] of coverageFiles) {
        const coverageSuffix = getPathSuffix(coveragePath, matchDepth);
        if (localSuffix === coverageSuffix) {
            return coverage;
        }
    }

    if (matchDepth > 2) {
        return findMatchingCoverage(localFilePath, coverageFiles, matchDepth - 1);
    }

    return undefined;
}

const filePathCache: Map<string, string | null> = new Map();

export async function findLocalFilePathAsync(
    coverageFilePath: string,
    matchDepth: number = 5
): Promise<string | undefined> {
    const cached = filePathCache.get(coverageFilePath);
    if (cached !== undefined) {
        return cached || undefined;
    }

    const coverageSuffix = getPathSuffix(coverageFilePath, matchDepth);
    const fileName = coverageFilePath.split(/[/\\]/).pop() || '';

    if (!fileName) {
        filePathCache.set(coverageFilePath, null);
        return undefined;
    }

    try {
        const vscode = await import('vscode');
        const files = await vscode.workspace.findFiles(
            `**/${fileName}`,
            '**/node_modules/**',
            10
        );

        for (const file of files) {
            if (getPathSuffix(file.fsPath, matchDepth) === coverageSuffix) {
                filePathCache.set(coverageFilePath, file.fsPath);
                return file.fsPath;
            }
        }

        if (matchDepth > 2) {
            return findLocalFilePathAsync(coverageFilePath, matchDepth - 1);
        }

        filePathCache.set(coverageFilePath, null);
        return undefined;
    } catch {
        filePathCache.set(coverageFilePath, null);
        return undefined;
    }
}

export function clearFilePathCache(): void {
    filePathCache.clear();
}
