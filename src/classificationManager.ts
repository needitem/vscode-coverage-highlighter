import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface ClassifiedLine {
    filePath: string;
    fileName: string;
    line: number;
    reason: string;
    category: 'document' | 'comment-planned' | 'cover-planned';
}

export interface ReasonItem {
    id: string;
    label: string;
}

/**
 * 미달성 라인 분류 관리자
 */
export class ClassificationManager {
    private classifications: Map<string, ClassifiedLine[]> = new Map();
    private reasons: ReasonItem[] = [];
    private context: vscode.ExtensionContext;
    private static readonly REASONS_KEY = 'coverage-highlighter.reasons';
    private static readonly CLASSIFICATIONS_KEY = 'coverage-highlighter.classifications';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadReasons();
        this.loadClassifications();
    }

    /**
     * 저장된 사유 목록 로드
     */
    private loadReasons(): void {
        const saved = this.context.globalState.get<ReasonItem[]>(ClassificationManager.REASONS_KEY);
        if (saved) {
            this.reasons = saved;
        } else {
            // 기본 사유 없음 - 빈 목록으로 시작
            this.reasons = [];
        }
    }

    /**
     * 저장된 분류 로드
     */
    private loadClassifications(): void {
        const saved = this.context.globalState.get<[string, ClassifiedLine[]][]>(ClassificationManager.CLASSIFICATIONS_KEY);
        if (saved) {
            this.classifications = new Map(saved);
        }
    }

    /**
     * 사유 목록 저장
     */
    private async saveReasons(): Promise<void> {
        await this.context.globalState.update(ClassificationManager.REASONS_KEY, this.reasons);
    }

    /**
     * 분류 저장
     */
    private async saveClassifications(): Promise<void> {
        const entries = Array.from(this.classifications.entries());
        await this.context.globalState.update(ClassificationManager.CLASSIFICATIONS_KEY, entries);
    }

    /**
     * 사유 목록 가져오기
     */
    public getReasons(): ReasonItem[] {
        return [...this.reasons];
    }

    /**
     * 새 사유 추가
     */
    public async addReason(label: string): Promise<ReasonItem> {
        const id = `custom-${Date.now()}`;
        const newReason: ReasonItem = { id, label };
        this.reasons.push(newReason);
        await this.saveReasons();
        return newReason;
    }

    /**
     * 사유 삭제
     */
    public async removeReason(id: string): Promise<void> {
        this.reasons = this.reasons.filter(r => r.id !== id);
        await this.saveReasons();
    }

    /**
     * 라인 분류하기
     */
    public async classifyLine(
        filePath: string,
        line: number,
        category: 'document' | 'comment-planned' | 'cover-planned',
        reason: string
    ): Promise<void> {
        const key = this.getKey(category, reason);
        const fileName = path.basename(filePath);

        const classification: ClassifiedLine = {
            filePath,
            fileName,
            line,
            reason,
            category
        };

        if (!this.classifications.has(key)) {
            this.classifications.set(key, []);
        }

        const list = this.classifications.get(key)!;

        // 중복 체크
        const exists = list.some(c => c.filePath === filePath && c.line === line);
        if (!exists) {
            list.push(classification);
            await this.saveClassifications();
        }
    }

    /**
     * 여러 라인 분류하기
     */
    public async classifyLines(
        filePath: string,
        lines: number[],
        category: 'document' | 'comment-planned' | 'cover-planned',
        reason: string
    ): Promise<void> {
        for (const line of lines) {
            await this.classifyLine(filePath, line, category, reason);
        }
    }

    /**
     * 분류 제거
     */
    public async removeClassification(filePath: string, line: number): Promise<void> {
        for (const [key, list] of this.classifications.entries()) {
            const index = list.findIndex(c => c.filePath === filePath && c.line === line);
            if (index !== -1) {
                list.splice(index, 1);
                if (list.length === 0) {
                    this.classifications.delete(key);
                }
            }
        }
        await this.saveClassifications();
    }

    /**
     * 카테고리별 분류 가져오기
     */
    public getClassificationsByCategory(category: 'document' | 'comment-planned' | 'cover-planned'): Map<string, ClassifiedLine[]> {
        const result = new Map<string, ClassifiedLine[]>();

        for (const [key, list] of this.classifications.entries()) {
            if (key.startsWith(category + ':')) {
                const reason = key.substring(category.length + 1);
                result.set(reason, list);
            }
        }

        return result;
    }

    /**
     * 모든 분류 가져오기
     */
    public getAllClassifications(): Map<string, ClassifiedLine[]> {
        return new Map(this.classifications);
    }

    /**
     * 분류 키 생성
     */
    private getKey(category: string, reason: string): string {
        return `${category}:${reason}`;
    }

    /**
     * 보고서 생성 - 문서용
     */
    public generateDocumentReport(): string {
        const documentClassifications = this.getClassificationsByCategory('document');

        if (documentClassifications.size === 0) {
            return '분류된 항목이 없습니다.';
        }

        let report = '# 미달성 코드 분류 보고서\n\n';
        report += `생성일: ${new Date().toLocaleString('ko-KR')}\n\n`;

        for (const [reason, items] of documentClassifications.entries()) {
            report += `## ${reason}\n\n`;

            // 파일별로 그룹화
            const byFile = new Map<string, number[]>();
            for (const item of items) {
                if (!byFile.has(item.fileName)) {
                    byFile.set(item.fileName, []);
                }
                byFile.get(item.fileName)!.push(item.line);
            }

            report += '| 번호 | 파일명 | 코드위치 | 비고 |\n';
            report += '|------|--------|----------|------|\n';

            let index = 1;
            for (const [fileName, lines] of byFile.entries()) {
                lines.sort((a, b) => a - b);
                const linesStr = lines.join(' ');
                report += `| ${index} | ${fileName} | ${linesStr} | |\n`;
                index++;
            }

            report += '\n';
        }

        return report;
    }

    /**
     * 보고서 생성 - 전체
     */
    public generateFullReport(): string {
        let report = '# 미달성 코드 분류 전체 보고서\n\n';
        report += `생성일: ${new Date().toLocaleString('ko-KR')}\n\n`;

        const categories = [
            { key: 'document' as const, label: '문서화 대상' },
            { key: 'comment-planned' as const, label: '주석 예정' },
            { key: 'cover-planned' as const, label: '태울 예정' }
        ];

        for (const cat of categories) {
            const classifications = this.getClassificationsByCategory(cat.key);

            if (classifications.size === 0) {
                continue;
            }

            report += `## ${cat.label}\n\n`;

            for (const [reason, items] of classifications.entries()) {
                report += `### ${reason}\n\n`;

                // 파일별로 그룹화
                const byFile = new Map<string, number[]>();
                for (const item of items) {
                    if (!byFile.has(item.fileName)) {
                        byFile.set(item.fileName, []);
                    }
                    byFile.get(item.fileName)!.push(item.line);
                }

                report += '| 번호 | 파일명 | 코드위치 | 비고 |\n';
                report += '|------|--------|----------|------|\n';

                let index = 1;
                for (const [fileName, lines] of byFile.entries()) {
                    lines.sort((a, b) => a - b);
                    const linesStr = lines.join(' ');
                    report += `| ${index} | ${fileName} | ${linesStr} | |\n`;
                    index++;
                }

                report += '\n';
            }
        }

        return report;
    }

    /**
     * 모든 분류 초기화
     */
    public async clearAll(): Promise<void> {
        this.classifications.clear();
        await this.saveClassifications();
    }

    /**
     * 특정 파일의 라인이 분류되었는지 확인
     */
    public isClassified(filePath: string, line: number): ClassifiedLine | undefined {
        for (const list of this.classifications.values()) {
            const found = list.find(c => c.filePath === filePath && c.line === line);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
}
