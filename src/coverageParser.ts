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

// Find local file path matching coverage file path in workspace
export function findLocalFilePath(
    coverageFilePath: string,
    workspaceRoot: string,
    matchDepth: number = 5
): string | undefined {
    const fs = require('fs');
    const path = require('path');

    const covSuffix = getPathSuffix(coverageFilePath, matchDepth);
    const suffixParts = covSuffix.split('/');

    // Try to find file in workspace
    function searchDir(dir: string, depth: number): string | undefined {
        if (depth > 10) return undefined; // Prevent infinite recursion

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    // Skip common non-source directories
                    if (['node_modules', '.git', 'bin', 'obj', 'dist', 'out'].includes(entry.name)) {
                        continue;
                    }
                    const result = searchDir(fullPath, depth + 1);
                    if (result) return result;
                } else if (entry.isFile()) {
                    const localSuffix = getPathSuffix(fullPath, matchDepth);
                    if (localSuffix === covSuffix) {
                        return fullPath;
                    }
                }
            }
        } catch {
            // Ignore permission errors etc
        }

        return undefined;
    }

    const result = searchDir(workspaceRoot, 0);
    if (result) return result;

    // Try with shorter match if not found
    if (matchDepth > 2) {
        return findLocalFilePath(coverageFilePath, workspaceRoot, matchDepth - 1);
    }

    return undefined;
}
