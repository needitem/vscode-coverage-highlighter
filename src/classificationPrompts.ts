import * as vscode from 'vscode';
import { ClassificationManager } from './classificationManager';
import {
    ClassificationCategory,
    getCategoryOptions,
    requiresReason
} from './classification';

export interface ClassificationSelection {
    category: ClassificationCategory;
    reason: string;
}

interface PromptOptions {
    category?: ClassificationCategory;
    categoryPlaceHolder?: string;
    reasonPlaceHolder?: string;
    includeCategoryDescriptions?: boolean;
}

export async function promptForClassification(
    classificationManager: ClassificationManager,
    options: PromptOptions = {}
): Promise<ClassificationSelection | undefined> {
    const category = options.category ?? await promptForCategory(
        options.categoryPlaceHolder,
        options.includeCategoryDescriptions
    );

    if (!category) {
        return undefined;
    }

    const reason = await promptForReason(
        classificationManager,
        category,
        options.reasonPlaceHolder
    );

    if (reason === undefined) {
        return undefined;
    }

    return { category, reason };
}

export async function promptForCategory(
    placeHolder: string = 'Select a classification category',
    includeDescriptions: boolean = true
): Promise<ClassificationCategory | undefined> {
    const choice = await vscode.window.showQuickPick(
        getCategoryOptions(includeDescriptions),
        { placeHolder }
    );

    return choice?.value;
}

export async function promptForReason(
    classificationManager: ClassificationManager,
    category: ClassificationCategory,
    placeHolder: string = 'Select a reason'
): Promise<string | undefined> {
    if (!requiresReason(category)) {
        return '';
    }

    const reasons = classificationManager.getReasons();
    if (reasons.length === 0) {
        return promptForNewReason(classificationManager);
    }

    const choice = await vscode.window.showQuickPick(
        [
            ...reasons.map(reason => ({ label: reason.label, value: reason.label })),
            { label: '$(add) Add a new reason...', value: '__new__' }
        ],
        { placeHolder }
    );

    if (!choice) {
        return undefined;
    }

    if (choice.value === '__new__') {
        return promptForNewReason(classificationManager);
    }

    return choice.value;
}

export async function promptForNewReason(
    classificationManager?: ClassificationManager,
    prompt: string = 'Enter a reason',
    placeHolder: string = 'Example: UI-related code'
): Promise<string | undefined> {
    const reason = await vscode.window.showInputBox({
        prompt,
        placeHolder
    });

    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
        return undefined;
    }

    if (classificationManager) {
        await classificationManager.addReason(trimmedReason);
    }

    return trimmedReason;
}
