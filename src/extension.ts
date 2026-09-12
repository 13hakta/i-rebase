import * as vscode from 'vscode';
import { GitService, classifyGitError, logGitError, showGitLog, GitErrorKind } from './gitService';
import { RebaseEditorProvider } from './rebaseEditor';

// Run interactive rebase with progress indication and unified error handling
async function runRebase(target: string): Promise<void> {
    const gitService = new GitService();

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.SourceControl,
                title: 'Starting interactive rebase...',
                cancellable: true
            },
            async (_progress, token) => {
                let cancelled = false;
                token.onCancellationRequested(() => {
                    cancelled = true;
                });

                try {
                    await gitService.startRebase(target);
                } finally {
                    if (cancelled) {
                        try {
                            await gitService.abortRebase();
                        } catch (abortError) {
                            logGitError('Failed to abort rebase after cancellation', abortError);
                        }
                    }
                }
            }
        );
    } catch (error: any) {
        const info = classifyGitError(error);
        logGitError('Failed to start interactive rebase', error);
        await handleRebaseError(gitService, target, info.kind, info.message);
    }
}

// Unified handling of typical rebase failure scenarios
async function handleRebaseError(gitService: GitService, target: string, kind: GitErrorKind, message: string): Promise<void> {
    switch (kind) {
        case 'dirty-tree': {
            const choice = await vscode.window.showErrorMessage(
                'Cannot start rebase: working tree has uncommitted changes.',
                'Stash',
                'Retry'
            );
            if (choice === 'Stash') {
                if (await gitService.stashChanges()) {
                    vscode.window.setStatusBarMessage('Changes stashed, retrying rebase...', 3000);
                    await runRebase(target);
                }
            } else if (choice === 'Retry') {
                await runRebase(target);
            }
            break;
        }

        case 'rebase-in-progress': {
            const choice = await vscode.window.showErrorMessage(
                'A rebase is already in progress.',
                'Open Rebase Editor'
            );
            if (choice === 'Open Rebase Editor')
                await gitService.openGitRebaseTodo();
            break;
        }

        case 'conflict': {
            const choice = await vscode.window.showErrorMessage(
                `Rebase stopped with conflicts:\n${message}`,
                'Open Rebase Editor',
                'Abort'
            );
            if (choice === 'Open Rebase Editor')
                await gitService.openGitRebaseTodo();
            else if (choice === 'Abort') {
                try {
                    await gitService.abortRebase();
                } catch (abortError) {
                    logGitError('Failed to abort rebase', abortError);
                }
            }
            break;
        }

        case 'aborted': {
            // Rebase was aborted from the editor UI - not an error
            if (await gitService.isRebaseStarted())
                await gitService.openGitRebaseTodo();
            else
                vscode.window.showInformationMessage('Interactive rebase was aborted.');
            break;
        }

        case 'no-upstream': {
            vscode.window.showErrorMessage(`Cannot start rebase: ${message}`);
            break;
        }

        default: {
            const choice = await vscode.window.showErrorMessage(
                `Failed to start interactive rebase:\n${message}`,
                'Show Log'
            );
            if (choice === 'Show Log')
                vscode.commands.executeCommand('irebase.showOutput');
            break;
        }
    }
}

// Prompt user for an arbitrary refspec and validate it
async function promptForRefspec(gitService: GitService): Promise<string | null> {
    const ref = await vscode.window.showInputBox({
        prompt: 'Enter refspec to rebase onto (branch, tag, commit hash or HEAD~N)',
        placeHolder: 'e.g. main, origin/main, v1.0, HEAD~10',
        validateInput: async (value) => {
            if (!value.trim())
                return 'Enter a refspec';
            if (!(await gitService.validateRef(value)))
                return `Unknown revision: ${value}`;
            return null;
        }
    });

    if (!ref)
        return null;

    return gitService.validateRef(ref);
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(RebaseEditorProvider.register(context));

    // Show the I-Rebase output channel for diagnostics
    context.subscriptions.push(
        vscode.commands.registerCommand('irebase.showOutput', () => {
            showGitLog();
        })
    );

    // Submenu entries: fixed presets (20 / 50)
    for (const [id, numCommits] of [
        ['irebase.rebasePreset20:scm', 20],
        ['irebase.rebasePreset50:scm', 50]
    ] as Array<[string, number]>) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async () => {
                const gitService = new GitService();

                if (await gitService.isRebaseStarted()) {
                    await gitService.openGitRebaseTodo();
                    return;
                }

                const target = await gitService.getNthLastCommit(numCommits);
                if (target)
                    await runRebase(target);
            })
        );
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('irebase.rebaseUpToPush:scm', async () => {
            const gitService = new GitService();

            if (await gitService.isRebaseStarted()) {
                await gitService.openGitRebaseTodo();
                return;
            }

            const target = await gitService.getUpstreamMergeBase();
            if (target)
                await runRebase(target);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('irebase.rebaseCustomRef:scm', async () => {
            const gitService = new GitService();

            if (await gitService.isRebaseStarted()) {
                await gitService.openGitRebaseTodo();
                return;
            }

            const target = await promptForRefspec(gitService);
            if (target)
                await runRebase(target);
        })
    );

    // Legacy commands (kept for backwards compatibility)
    context.subscriptions.push(
        vscode.commands.registerCommand('irebase.initRebaseLastCommits:scm', async () => {
            const gitService = new GitService();

            if (await gitService.isRebaseStarted()) {
                await gitService.openGitRebaseTodo();
                return;
            }

            const input = await vscode.window.showInputBox({
                prompt: 'Enter number of last commits to include in rebase',
                validateInput: (value) => {
                    const num = parseInt(value);
                    return isNaN(num) || num <= 0 ? 'Enter a positive number' : null;
                }
            });

            if (input) {
                const numCommits = parseInt(input);
                if (numCommits > 0) {
                    const target = await gitService.getNthLastCommit(numCommits);
                    if (target)
                        await runRebase(target);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('irebase.initRebaseLast50Commits:scm', async () => {
            const gitService = new GitService();

            if (await gitService.isRebaseStarted()) {
                await gitService.openGitRebaseTodo();
                return;
            }

            const target = await gitService.getNthLastCommit(50);
            if (target)
                await runRebase(target);
        })
    );
}

export function deactivate() { }
