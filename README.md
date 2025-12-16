# Coverage Highlighter

VS Code 확장 프로그램으로, Coverage XML 파일을 사용하여 코드 커버리지를 시각화합니다.

## 기능

### 커버리지 시각화
- **녹색**: 커버된 코드
- **적색**: 커버되지 않은 코드
- **황색**: 부분 커버된 코드

### 미분류 코드 관리
- 미커버 라인을 카테고리별로 분류
  - **문서**: 문서화 대상 (보고서에 포함)
  - **주석 예정**: 주석 처리 예정
  - **태울 예정**: 커버리지 달성 예정
- 사유별 그룹화 및 관리
- 분류된 항목 숨기기/보이기 토글

### 트리뷰
- 미분류 항목 목록
- 분류된 항목 카테고리별 조회
- 다중 선택 후 일괄 분류/삭제/수정
- 최근 XML 파일 빠른 접근

### 보고서 생성
- 문서용 보고서 (마크다운)
- 전체 보고서

## 사용법

1. **XML 로드**: 트리뷰에서 "XML 로드" 클릭 또는 Command Palette에서 `Coverage: Load Coverage XML`
2. **라인 분류**: 미분류 항목 클릭 → 카테고리/사유 선택
3. **일괄 분류**: Shift+클릭으로 여러 항목 선택 → 우클릭 → "선택 항목 일괄 분류"
4. **보고서 생성**: 트리뷰에서 "보고서 생성" 클릭

## 단축키

| 단축키 | 기능 |
|--------|------|
| `Ctrl+Shift+1` | 문서로 분류 |
| `Ctrl+Shift+2` | 주석예정으로 분류 |
| `Ctrl+Shift+3` | 태울예정으로 분류 |
| `Ctrl+Shift+4~9` | 사용자 정의 슬롯 |

## 설정

```json
{
  "coverageHighlighter.coveredColor": "rgba(0, 255, 0, 0.2)",
  "coverageHighlighter.uncoveredColor": "rgba(255, 0, 0, 0.2)",
  "coverageHighlighter.partialColor": "rgba(255, 255, 0, 0.2)",
  "coverageHighlighter.quickSlot1": { "category": "document", "reason": "" },
  "coverageHighlighter.quickSlot2": { "category": "comment-planned", "reason": "" },
  "coverageHighlighter.quickSlot3": { "category": "cover-planned", "reason": "" }
}
```

## 지원 포맷

- VectorCAST Coverage XML (`cv.CoverResult` 형식)

## License

MIT
