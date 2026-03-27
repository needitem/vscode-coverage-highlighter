export const CLASSIFICATION_CATEGORIES = ['document', 'comment-planned', 'cover-planned'] as const;

export type ClassificationCategory = typeof CLASSIFICATION_CATEGORIES[number];

export interface CategoryOption {
    label: string;
    value: ClassificationCategory;
    description?: string;
}

const CATEGORY_OPTIONS_WITH_DESCRIPTIONS: readonly CategoryOption[] = [
    {
        label: 'Document',
        value: 'document',
        description: 'Include the uncovered lines in a documentation report'
    },
    {
        label: 'Comment Planned',
        value: 'comment-planned',
        description: 'Handle the uncovered lines with comments later'
    },
    {
        label: 'Cover Planned',
        value: 'cover-planned',
        description: 'Add coverage for the uncovered lines later'
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
            return 'Document';
        case 'comment-planned':
            return 'Comment Planned';
        case 'cover-planned':
            return 'Cover Planned';
    }
}

export function requiresReason(category: ClassificationCategory): boolean {
    return category === 'document';
}
