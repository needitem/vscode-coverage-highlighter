import * as vscode from 'vscode';

export interface TrackedLines {
    coveredLines: Set<number>;
    uncoveredLines: Set<number>;
    partialCoveredLines: Set<number>;
}

/**
 * 문서 변경 시 라인 번호를 추적하는 클래스
 * 라인 추가/삭제에 따라 coverage 라인 번호를 자동으로 조정
 */
export class LineTracker {
    // 파일별 추적 중인 라인 정보
    private trackedFiles: Map<string, TrackedLines> = new Map();

    // 원본 라인 정보 (리셋용)
    private originalLines: Map<string, TrackedLines> = new Map();

    /**
     * 파일의 coverage 라인 정보를 등록
     */
    public registerFile(filePath: string, lines: TrackedLines): void {
        // 깊은 복사로 저장
        const copy: TrackedLines = {
            coveredLines: new Set(lines.coveredLines),
            uncoveredLines: new Set(lines.uncoveredLines),
            partialCoveredLines: new Set(lines.partialCoveredLines)
        };

        this.trackedFiles.set(filePath, copy);

        // 원본도 저장
        this.originalLines.set(filePath, {
            coveredLines: new Set(lines.coveredLines),
            uncoveredLines: new Set(lines.uncoveredLines),
            partialCoveredLines: new Set(lines.partialCoveredLines)
        });
    }

    /**
     * 파일의 현재 추적 중인 라인 정보 반환
     */
    public getTrackedLines(filePath: string): TrackedLines | undefined {
        return this.trackedFiles.get(filePath);
    }

    /**
     * 문서 변경 이벤트 처리
     */
    public handleDocumentChange(event: vscode.TextDocumentChangeEvent): boolean {
        const filePath = event.document.uri.fsPath;
        const tracked = this.trackedFiles.get(filePath);

        if (!tracked) {
            return false;
        }

        let changed = false;

        for (const change of event.contentChanges) {
            const startLine = change.range.start.line + 1; // 1-based
            const endLine = change.range.end.line + 1;

            // 변경된 텍스트의 줄 수 계산
            const oldLineCount = endLine - startLine + 1;
            const newLineCount = (change.text.match(/\n/g) || []).length + 1;
            const lineDelta = newLineCount - oldLineCount;

            if (lineDelta !== 0) {
                // 라인 추가 또는 삭제됨
                this.adjustLines(tracked.coveredLines, startLine, endLine, lineDelta);
                this.adjustLines(tracked.uncoveredLines, startLine, endLine, lineDelta);
                this.adjustLines(tracked.partialCoveredLines, startLine, endLine, lineDelta);
                changed = true;
            }

            // 삭제된 라인 범위에 있던 coverage 정보 제거
            if (oldLineCount > newLineCount) {
                const deleteStart = startLine;
                const deleteEnd = startLine + (oldLineCount - newLineCount) - 1;
                this.removeLines(tracked.coveredLines, deleteStart, deleteEnd);
                this.removeLines(tracked.uncoveredLines, deleteStart, deleteEnd);
                this.removeLines(tracked.partialCoveredLines, deleteStart, deleteEnd);
                changed = true;
            }
        }

        return changed;
    }

    /**
     * 라인 번호 조정
     */
    private adjustLines(lineSet: Set<number>, startLine: number, endLine: number, delta: number): void {
        const newSet = new Set<number>();

        for (const line of lineSet) {
            if (line < startLine) {
                // 변경 지점 이전의 라인은 그대로
                newSet.add(line);
            } else if (line > endLine) {
                // 변경 지점 이후의 라인은 delta만큼 조정
                newSet.add(line + delta);
            } else {
                // 변경 범위 내의 라인
                if (delta >= 0) {
                    // 라인 추가: 기존 라인 유지
                    newSet.add(line + delta);
                } else {
                    // 라인 삭제: 삭제 범위 밖이면 조정하여 유지
                    const adjustedLine = line + delta;
                    if (adjustedLine >= startLine) {
                        newSet.add(adjustedLine);
                    }
                }
            }
        }

        lineSet.clear();
        for (const line of newSet) {
            lineSet.add(line);
        }
    }

    /**
     * 특정 범위의 라인 제거
     */
    private removeLines(lineSet: Set<number>, startLine: number, endLine: number): void {
        for (let line = startLine; line <= endLine; line++) {
            lineSet.delete(line);
        }
    }

    /**
     * 파일의 라인 정보를 원본으로 리셋
     */
    public resetFile(filePath: string): void {
        const original = this.originalLines.get(filePath);
        if (original) {
            this.trackedFiles.set(filePath, {
                coveredLines: new Set(original.coveredLines),
                uncoveredLines: new Set(original.uncoveredLines),
                partialCoveredLines: new Set(original.partialCoveredLines)
            });
        }
    }

    /**
     * 모든 추적 정보 초기화
     */
    public clear(): void {
        this.trackedFiles.clear();
        this.originalLines.clear();
    }

    /**
     * 파일 등록 해제
     */
    public unregisterFile(filePath: string): void {
        this.trackedFiles.delete(filePath);
        this.originalLines.delete(filePath);
    }
}
