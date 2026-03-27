export function normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}

export function getPathSuffix(filePath: string, depth: number = 5): string {
    const normalized = normalizePath(filePath);
    const parts = normalized.split('/').filter(part => part.length > 0);
    return parts.slice(-depth).join('/');
}

export function pathsMatch(path1: string, path2: string, depth: number = 5): boolean {
    return getPathSuffix(path1, depth) === getPathSuffix(path2, depth);
}
