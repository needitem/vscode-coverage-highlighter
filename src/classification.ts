export const CLASSIFICATION_CATEGORIES = ['document', 'comment-planned', 'cover-planned'] as const;

export type ClassificationCategory = typeof CLASSIFICATION_CATEGORIES[number];

export interface CategoryOption {
    label: string;
    value: ClassificationCategory;
    description?: string;
}

const CATEGORY_OPTIONS_WITH_DESCRIPTIONS: readonly CategoryOption[] = [
    {
        label: '문서',
        value: 'document',
        description: '보고서에 포함할 미커버 코드를 분류합니다'
    },
    {
        label: '주석 예정',
        value: 'comment-planned',
        description: '추후 주석 처리할 코드를 분류합니다'
    },
    {
        label: '커버 예정',
        value: 'cover-planned',
        description: '추후 커버리지를 추가할 코드를 분류합니다'
    }
];

export function getCategoryOptions(includeDescriptions: boolean = true): CategoryOption[] {
    return CATEGORY_OPTIONS_WITH_DESCRIPTIONS.map(option => (
        includeDescriptions ? { ...option } : { label: option.label, value: option.value }
    ));
}

export function getCategoryLabel(category: ClassificationCategory): string {
    switch (category) {
        case 'document':
            return '문서';
        case 'comment-planned':
            return '주석 예정';
        case 'cover-planned':
            return '커버 예정';
    }
}

export function requiresReason(category: ClassificationCategory): boolean {
    return category === 'document';
}
