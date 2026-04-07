import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface CoverageCacheData {
    xmlPath?: string;
    recentXmlFiles: string[];
    lineOffsets: Record<string, Record<number, number>>;
}

function stripUtf8Bom(content: string): string {
    return content.charCodeAt(0) === 0xfeff
        ? content.slice(1)
        : content;
}

function collectAncestorVscodeDirs(startPath: string, dirs: Set<string>): void {
    let currentPath = startPath;

    while (true) {
        dirs.add(path.join(currentPath, '.vscode'));

        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            break;
        }

        currentPath = parentPath;
    }
}

function collectDescendantCacheDirs(
    startPath: string,
    dirs: Set<string>,
    depth: number
): void {
    if (depth < 0 || !fs.existsSync(startPath)) {
        return;
    }

    try {
        const entries = fs.readdirSync(startPath, { withFileTypes: true });

        for (const entry of entries) {
            const entryPath = path.join(startPath, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.vscode') {
                    dirs.add(entryPath);
                    continue;
                }

                collectDescendantCacheDirs(entryPath, dirs, depth - 1);
                continue;
            }

            if (entry.isFile() && entry.name === 'coverage-cache.json') {
                dirs.add(path.dirname(entryPath));
            }
        }
    } catch {
        // Ignore inaccessible paths and continue.
    }
}

function getWorkspaceVscodeDirs(): string[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return [];
    }

    const dirs = new Set<string>();

    for (const folder of workspaceFolders) {
        const rootPath = folder.uri.fsPath;
        collectAncestorVscodeDirs(rootPath, dirs);
        collectDescendantCacheDirs(rootPath, dirs, 3);
    }

    return Array.from(dirs);
}

function getCacheFilePath(): string | undefined {
    const candidateDirs = getWorkspaceVscodeDirs();
    if (candidateDirs.length === 0) {
        return undefined;
    }

    for (const dir of candidateDirs) {
        const candidate = path.join(dir, 'coverage-cache.json');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return path.join(candidateDirs[0], 'coverage-cache.json');
}

export function loadCoverageCache(): CoverageCacheData | undefined {
    const cachePath = getCacheFilePath();
    if (!cachePath || !fs.existsSync(cachePath)) {
        return undefined;
    }

    try {
        const content = stripUtf8Bom(fs.readFileSync(cachePath, 'utf-8'));
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
