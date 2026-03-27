import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface CoverageCacheData {
    xmlPath?: string;
    recentXmlFiles: string[];
    lineOffsets: Record<string, Record<number, number>>;
}

function getCacheFilePath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }

    return path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'coverage-cache.json');
}

export function loadCoverageCache(): CoverageCacheData | undefined {
    const cachePath = getCacheFilePath();
    if (!cachePath || !fs.existsSync(cachePath)) {
        return undefined;
    }

    try {
        const content = fs.readFileSync(cachePath, 'utf-8');
        return JSON.parse(content) as CoverageCacheData;
    } catch {
        return undefined;
    }
}

export async function saveCoverageCache(cache: CoverageCacheData): Promise<void> {
    const cachePath = getCacheFilePath();
    if (!cachePath) {
        return;
    }

    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
        await fs.promises.mkdir(cacheDir, { recursive: true });
    }

    await fs.promises.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
}
