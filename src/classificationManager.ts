import * as path from 'path';
import * as vscode from 'vscode';
import { ClassificationCategory } from './classification';
import { getPathSuffix, pathsMatch } from './pathUtils';

export interface ClassifiedLine {
    filePath: string;
    fileName: string;
    line: number;
    reason: string;
    category: ClassificationCategory;
}

export interface ReasonItem {
    id: string;
    label: string;
}

export interface ClassificationTarget {
    filePath: string;
    line: number;
}

interface IndexedClassification {
    key: string;
    item: ClassifiedLine;
}

export class ClassificationManager {
    private classifications: Map<string, ClassifiedLine[]> = new Map();
    private reasons: ReasonItem[] = [];
    private readonly context: vscode.ExtensionContext;
    private static readonly REASONS_KEY = 'coverage-highlighter.reasons';
    private static readonly CLASSIFICATIONS_KEY = 'coverage-highlighter.classifications';
    private classificationIndex: Map<string, IndexedClassification> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadReasons();
        this.loadClassifications();
        this.normalizeClassifications();
    }

    public getReasons(): ReasonItem[] {
        return [...this.reasons];
    }

    public async addReason(label: string): Promise<ReasonItem> {
        const normalizedLabel = label.trim();
        const existing = this.reasons.find(reason => reason.label === normalizedLabel);
        if (existing) {
            return existing;
        }

        const newReason: ReasonItem = {
            id: `custom-${Date.now()}`,
            label: normalizedLabel
        };

        this.reasons.push(newReason);
        await this.saveReasons();
        return newReason;
    }

    public async removeReason(id: string): Promise<void> {
        this.reasons = this.reasons.filter(reason => reason.id !== id);
        await this.saveReasons();
    }

    public async classifyLine(
        filePath: string,
        line: number,
        category: ClassificationCategory,
        reason: string
    ): Promise<void> {
        await this.classifyLines(filePath, [line], category, reason);
    }

    public async classifyLines(
        filePath: string,
        lines: number[],
        category: ClassificationCategory,
        reason: string
    ): Promise<void> {
        await this.classifyTargets(
            this.toTargets(filePath, lines),
            category,
            reason
        );
    }

    public async classifyTargets(
        targets: ClassificationTarget[],
        category: ClassificationCategory,
        reason: string
    ): Promise<void> {
        const normalizedReason = reason.trim();
        let changed = false;

        for (const target of this.deduplicateTargets(targets)) {
            const nextItem: ClassifiedLine = {
                filePath: target.filePath,
                fileName: path.basename(target.filePath),
                line: target.line,
                reason: normalizedReason,
                category
            };

            changed = this.upsertClassification(nextItem) || changed;
        }

        if (changed) {
            await this.saveClassifications();
        }
    }

    public async removeClassification(filePath: string, line: number): Promise<void> {
        await this.removeClassifications([{ filePath, line }]);
    }

    public async removeClassifications(targets: ClassificationTarget[]): Promise<void> {
        let changed = false;

        for (const target of this.deduplicateTargets(targets)) {
            changed = this.removeClassificationInternal(target.filePath, target.line) || changed;
        }

        if (changed) {
            await this.saveClassifications();
        }
    }

    public getClassificationsByCategory(category: ClassificationCategory): Map<string, ClassifiedLine[]> {
        const result = new Map<string, ClassifiedLine[]>();

        for (const [key, list] of this.classifications.entries()) {
            if (key.startsWith(`${category}:`)) {
                result.set(key.substring(category.length + 1), list);
            }
        }

        return result;
    }

    public getAllClassifications(): Map<string, ClassifiedLine[]> {
        return new Map(this.classifications);
    }

    public generateDocumentReport(): string {
        const documentClassifications = this.getClassificationsByCategory('document');
        if (documentClassifications.size === 0) {
            return 'No classified lines found.';
        }

        let report = '# Uncovered Code Report\n\n';
        report += `Generated: ${new Date().toLocaleString('ko-KR')}\n\n`;

        for (const [reason, items] of documentClassifications.entries()) {
            report += `## ${reason || 'Unspecified'}\n\n`;
            report += this.buildReportTable(items);
            report += '\n';
        }

        return report;
    }

    public generateFullReport(): string {
        let report = '# Full Uncovered Code Report\n\n';
        report += `Generated: ${new Date().toLocaleString('ko-KR')}\n\n`;

        const categories: Array<{ key: ClassificationCategory; label: string }> = [
            { key: 'document', label: 'Document' },
            { key: 'comment-planned', label: 'Comment Planned' },
            { key: 'cover-planned', label: 'Cover Planned' }
        ];

        for (const category of categories) {
            const classifications = this.getClassificationsByCategory(category.key);
            if (classifications.size === 0) {
                continue;
            }

            report += `## ${category.label}\n\n`;
            for (const [reason, items] of classifications.entries()) {
                report += `### ${reason || 'Unspecified'}\n\n`;
                report += this.buildReportTable(items);
                report += '\n';
            }
        }

        return report;
    }

    public async clearAll(): Promise<void> {
        this.classifications.clear();
        this.classificationIndex.clear();
        await this.saveClassifications();
    }

    public isClassified(filePath: string, line: number): ClassifiedLine | undefined {
        return this.classificationIndex.get(this.getIndexKey(filePath, line))?.item;
    }

    private loadReasons(): void {
        const saved = this.context.workspaceState.get<ReasonItem[]>(ClassificationManager.REASONS_KEY);
        this.reasons = saved ?? [];
    }

    private loadClassifications(): void {
        const saved = this.context.workspaceState.get<[string, ClassifiedLine[]][]>(
            ClassificationManager.CLASSIFICATIONS_KEY
        );

        if (saved) {
            this.classifications = new Map(saved);
        }
    }

    private async saveReasons(): Promise<void> {
        await this.context.workspaceState.update(
            ClassificationManager.REASONS_KEY,
            this.reasons
        );
    }

    private async saveClassifications(): Promise<void> {
        await this.context.workspaceState.update(
            ClassificationManager.CLASSIFICATIONS_KEY,
            Array.from(this.classifications.entries())
        );
    }

    private normalizeClassifications(): void {
        const uniqueEntries = new Map<string, ClassifiedLine>();

        for (const list of this.classifications.values()) {
            for (const item of list) {
                const normalizedItem: ClassifiedLine = {
                    ...item,
                    reason: item.reason.trim()
                };

                uniqueEntries.set(
                    this.getIndexKey(normalizedItem.filePath, normalizedItem.line),
                    normalizedItem
                );
            }
        }

        this.classifications.clear();
        for (const item of uniqueEntries.values()) {
            const key = this.getKey(item.category, item.reason);
            const list = this.classifications.get(key) ?? [];
            list.push(item);
            this.classifications.set(key, list);
        }

        this.rebuildIndex();
    }

    private rebuildIndex(): void {
        this.classificationIndex.clear();

        for (const [key, list] of this.classifications.entries()) {
            for (const item of list) {
                this.classificationIndex.set(
                    this.getIndexKey(item.filePath, item.line),
                    { key, item }
                );
            }
        }
    }

    private getKey(category: ClassificationCategory, reason: string): string {
        return `${category}:${reason}`;
    }

    private getIndexKey(filePath: string, line: number): string {
        return `${getPathSuffix(filePath)}:${line}`;
    }

    private upsertClassification(nextItem: ClassifiedLine): boolean {
        const existing = this.classificationIndex.get(
            this.getIndexKey(nextItem.filePath, nextItem.line)
        );

        if (
            existing &&
            existing.item.category === nextItem.category &&
            existing.item.reason === nextItem.reason &&
            pathsMatch(existing.item.filePath, nextItem.filePath)
        ) {
            return false;
        }

        if (existing) {
            this.removeClassificationInternal(existing.item.filePath, existing.item.line);
        }

        const key = this.getKey(nextItem.category, nextItem.reason);
        const list = this.classifications.get(key) ?? [];
        list.push(nextItem);
        this.classifications.set(key, list);
        this.classificationIndex.set(this.getIndexKey(nextItem.filePath, nextItem.line), {
            key,
            item: nextItem
        });

        return true;
    }

    private removeClassificationInternal(filePath: string, line: number): boolean {
        const indexed = this.classificationIndex.get(this.getIndexKey(filePath, line));
        if (!indexed) {
            return false;
        }

        const list = this.classifications.get(indexed.key);
        if (!list) {
            this.classificationIndex.delete(this.getIndexKey(filePath, line));
            return false;
        }

        const itemIndex = list.findIndex(item =>
            item.line === indexed.item.line && pathsMatch(item.filePath, indexed.item.filePath)
        );

        if (itemIndex === -1) {
            this.classificationIndex.delete(this.getIndexKey(filePath, line));
            return false;
        }

        list.splice(itemIndex, 1);
        if (list.length === 0) {
            this.classifications.delete(indexed.key);
        }

        this.classificationIndex.delete(this.getIndexKey(filePath, line));
        return true;
    }

    private toTargets(filePath: string, lines: number[]): ClassificationTarget[] {
        return lines.map(line => ({ filePath, line }));
    }

    private deduplicateTargets(targets: ClassificationTarget[]): ClassificationTarget[] {
        const uniqueTargets = new Map<string, ClassificationTarget>();

        for (const target of targets) {
            uniqueTargets.set(this.getIndexKey(target.filePath, target.line), target);
        }

        return Array.from(uniqueTargets.values()).sort((a, b) => {
            const pathComparison = a.filePath.localeCompare(b.filePath);
            return pathComparison !== 0 ? pathComparison : a.line - b.line;
        });
    }

    private buildReportTable(items: ClassifiedLine[]): string {
        const byFile = new Map<string, number[]>();

        for (const item of items) {
            if (!byFile.has(item.fileName)) {
                byFile.set(item.fileName, []);
            }
            byFile.get(item.fileName)!.push(item.line);
        }

        let report = '| No. | File | Lines | Notes |\n';
        report += '| --- | --- | --- | --- |\n';

        let index = 1;
        for (const [fileName, lines] of byFile.entries()) {
            lines.sort((a, b) => a - b);
            report += `| ${index} | ${fileName} | ${lines.join(', ')} | |\n`;
            index++;
        }

        return report;
    }
}
