import * as vscode from 'vscode';
import { GitService } from './gitService';
import { RebaseEditorProvider } from './rebaseEditor';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(RebaseEditorProvider.register(context));

    context.subscriptions.push(
        vscode.commands.registerCommand('irebase.initRebaseLastCommits:scm', async () => {
            const gitService = new GitService();

            if (await gitService.isRebaseStarted()) {
                await gitService.openGitRebaseTodo();
            } else {
                // Prompt user for number of commits
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
                        const gitService = new GitService();
                        // Get the hash of the commit that is numCommits back
                        const targetCommit = await gitService.getNthLastCommit(numCommits);
                        if (targetCommit) {
                            await gitService.startRebase(targetCommit);
                        } else {
                            vscode.window.showErrorMessage('Could not determine target commit');
                        }
                    }
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('irebase.initRebaseLast50Commits:scm', async () => {
            const gitService = new GitService();

            if (await gitService.isRebaseStarted()) {
                await gitService.openGitRebaseTodo();
            } else {
                const gitService = new GitService();
                // Get the hash of the commit that is 50 back
                const targetCommit = await gitService.getNthLastCommit(50);
                if (targetCommit)
                    await gitService.startRebase(targetCommit);
            }
        })
    );
}

export function deactivate() { }
