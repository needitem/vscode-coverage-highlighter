import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ClassifiedLine, ReasonItem } from './classificationManager';

export interface ClassificationCacheData {
    version: number;
    reasons: ReasonItem[];
    classifications: ClassifiedLine[];
    updatedAt?: string;
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

            if (
                entry.isFile()
                && (entry.name === 'coverage-classifications.json' || entry.name === 'coverage-cache.json')
            ) {
                dirs.add(path.dirname(entryPath));
            }
        }
    } catch {
        // Ignore inaccessible paths and continue with other candidates.
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

function getClassificationCachePaths(): string[] {
    const candidateDirs = getWorkspaceVscodeDirs();
    if (candidateDirs.length === 0) {
        return [];
    }

    const paths = new Set<string>();

    for (const dir of candidateDirs) {
        const candidate = path.join(dir, 'coverage-classifications.json');
        if (fs.existsSync(candidate)) {
            paths.add(candidate);
        }
    }

    for (const dir of candidateDirs) {
        const siblingCoverageCache = path.join(dir, 'coverage-cache.json');
        if (fs.existsSync(siblingCoverageCache)) {
            paths.add(path.join(dir, 'coverage-classifications.json'));
        }
    }

    if (paths.size === 0) {
        paths.add(path.join(candidateDirs[0], 'coverage-classifications.json'));
    }

    return Array.from(paths);
}

function getClassificationCachePath(): string | undefined {
    return getClassificationCachePaths()[0];
}

export function loadClassificationCache(): ClassificationCacheData | undefined {
    const cachePaths = getClassificationCachePaths().filter(cachePath => fs.existsSync(cachePath));
    if (cachePaths.length === 0) {
        return undefined;
    }

    const reasons = new Map<string, ReasonItem>();
    const classifications = new Map<string, ClassifiedLine>();
    let updatedAt: string | undefined;

    for (const cachePath of cachePaths) {
        try {
            const content = stripUtf8Bom(fs.readFileSync(cachePath, 'utf-8'));
            const parsed = JSON.parse(content) as Partial<ClassificationCacheData>;

            if (Array.isArray(parsed.reasons)) {
                for (const reason of parsed.reasons) {
                    if (!reason || typeof reason.label !== 'string' || !reason.label.trim()) {
                        continue;
                    }

                    reasons.set(reason.label.trim(), {
                        id: typeof reason.id === 'string' && reason.id.trim()
                            ? reason.id
                            : `cache-${reason.label.trim()}`,
                        label: reason.label.trim()
                    });
                }
            }

            if (Array.isArray(parsed.classifications)) {
                for (const item of parsed.classifications) {
                    if (
                        !item
                        || typeof item.filePath !== 'string'
                        || typeof item.fileName !== 'string'
                        || typeof item.reason !== 'string'
                        || typeof item.category !== 'string'
                        || typeof item.line !== 'number'
                    ) {
                        continue;
                    }

                    classifications.set(
                        `${item.filePath}:${item.line}`,
                        {
                            filePath: item.filePath,
                            fileName: item.fileName,
                            line: item.line,
                            reason: item.reason.trim(),
                            category: item.category
                        }
                    );
                }
            }

            if (!updatedAt && typeof parsed.updatedAt === 'string') {
                updatedAt = parsed.updatedAt;
            }
        } catch {
            // Ignore malformed cache files and continue loading others.
        }
    }

    return {
        version: 1,
        reasons: Array.from(reasons.values()),
        classifications: Array.from(classifications.values()),
        updatedAt
    };
}

export async function saveClassificationCache(
    cache: ClassificationCacheData
): Promise<void> {
    const cachePath = getClassificationCachePath();
    if (!cachePath) {
        return;
    }

    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
        await fs.promises.mkdir(cacheDir, { recursive: true });
    }

    await fs.promises.writeFile(
        cachePath,
        JSON.stringify(cache, null, 2),
        'utf-8'
    );
}
