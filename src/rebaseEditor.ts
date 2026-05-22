import * as vscode from 'vscode';
import { GitService } from './gitService';
import { TodoCommand, CommitChange } from './types';

export class RebaseEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'irebase.gitRebaseTodoEditor';

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new RebaseEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(RebaseEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false
        });
        return providerRegistration;
    }

    constructor(private readonly context: vscode.ExtensionContext) { }

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const gitService = new GitService();
        const view: vscode.Webview = webviewPanel.webview;
        let preventUpdate: boolean = false;

        view.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };

        let config = vscode.workspace.getConfiguration();
        const queryParams = new URLSearchParams(document.uri.query);

        const options = {
            reverseOrder: config.get('irebase.reverseOrder', false),
            actionViewKind: config.get('irebase.actionViewKind', 'buttons'),
            continueMode: queryParams.has('continue')
        };

        view.html = this.getWebviewContent(view, options);

        const updateWebview = () => {
            if (!preventUpdate)
                gitService.parseRebaseFile(document).then(commits => {
                    view.postMessage({
                        type: 'update',
                        commits: commits
                    });
                });

            preventUpdate = false;
        };

        const willSaveSubscription = vscode.workspace.onWillSaveTextDocument(e => {
            if (e.document.uri.toString() !== document.uri.toString()) return;

            e.waitUntil(
                this.requestLatestContent(view).then(commands => {
                    preventUpdate = true;
                    const data = gitService.commandsToDo(commands);

                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );
                    return [vscode.TextEdit.replace(fullRange, data)];
                })
            );
        });
        this.context.subscriptions.push(willSaveSubscription);

        // Listen for document changes from outside
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0)
                updateWebview();
        });
        this.context.subscriptions.push(changeDocumentSubscription);

        view.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'changed':
                        if (document.isDirty) { return; }
                        preventUpdate = true;
                        await this.quasiUpdate(document);
                        break;
                    case 'saveContinue':
                        await this.saveContinue(document, webviewPanel, gitService);
                        break;
                    case 'abortRebase':
                        await this.abortRebase(webviewPanel, gitService);
                        break;
                    case 'confirmReset':
                        await this.handleConfirmReset(view);
                        break;
                    case 'saveContent':
                        this.resolveContent?.(message.commands);
                        break;
                    case 'commitChanges':
                        await this.commitChanges(view, gitService, message.hash);
                        break;
                    case 'checkConflicts':
                        await this.checkRebaseConflicts(view, gitService, message.commands);
                        break;
                    case 'changeOrder':
                        await config.update('irebase.reverseOrder', message.order, vscode.ConfigurationTarget.Global);
                        break;
                    case 'findIntersections':
                        await this.findIntersections(view, gitService, message.hash, message.all_commits);
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );

        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
            willSaveSubscription.dispose();
            gitService.clear();
        });

        updateWebview();
    }

    private async abortRebase(webviewPanel: vscode.WebviewPanel, gitService: GitService) {
        const result = await vscode.window.showWarningMessage(
            'Abort rebase?', { modal: true }, 'Yes'
        );

        if (result === 'Yes') {
            await gitService.abortRebase();
            webviewPanel.dispose();
        }
    }

    private async saveContinue(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, gitService: GitService) {
        await document.save();
        await gitService.continueRebase();
        webviewPanel.dispose();
    }

    private async quasiUpdate(document: vscode.TextDocument) {
        // Replace first char on itself to make document modified
        const edit = new vscode.WorkspaceEdit();
        const firstCharRange = new vscode.Range(0, 0, 0, 1);
        const firstChar = document.getText(firstCharRange);

        edit.replace(document.uri, firstCharRange, firstChar);
        await vscode.workspace.applyEdit(edit);
    }

    private async handleConfirmReset(webview: vscode.Webview) {
        const result = await vscode.window.showWarningMessage(
            'Reset to original state?', { modal: true }, 'Yes'
        );

        if (result === 'Yes') {
            // Send a message to the webview to reset the state
            webview.postMessage({ type: 'performReset' });
        }
    }

    private resolveContent?: (commands: TodoCommand[]) => void;

    private requestLatestContent(webview: vscode.Webview): Promise<TodoCommand[]> {
        return new Promise(resolve => {
            this.resolveContent = commands => {
                this.resolveContent = undefined;
                resolve(commands);
            };

            webview.postMessage({ type: 'requestContent' });
        });
    }

    private async commitChanges(webview: vscode.Webview, gitService: GitService, hash: string) {
        const changes: CommitChange[] = await gitService.getCommitChanges(hash);
        webview.postMessage({ type: 'commitChanges', hash: hash, changes: changes });
    }

    private async findIntersections(webview: vscode.Webview, gitService: GitService, hash: string, allCommits: string[]) {
        const intersections: string[] = await gitService.findIntersections(hash, allCommits);
        webview.postMessage({ type: 'intersections', hash: hash, intersections: intersections});
    }

    private async checkRebaseConflicts(webview: vscode.Webview, gitService: GitService, commands: TodoCommand[]) {
        if (commands.length === 0) {
            vscode.window.showWarningMessage('No commits to check for rebase plan conflicts.');
            return;
        }

        try {
            // Check for conflicts
            const result = await gitService.checkRebasePlan(commands);

            if (result.success) {
                vscode.window.showInformationMessage('No rebase conflicts found');

                // Explicitly send a message to clear any existing conflict flags
                webview.postMessage({
                    type: 'clearConflicts'
                });
            } else {
                if (result.hash) {
                    vscode.window.showErrorMessage('Conflict found in rebase plan');
                    webview.postMessage({
                        type: 'conflictFound',
                        hash: result.hash,
                        conflictFiles: result.conflictFiles
                    });
                }
                else vscode.window.showErrorMessage('Conflict found in rebase plan');
            }
        } catch (error) {
            console.error('Error checking rebase plan conflicts:', error);
            vscode.window.showErrorMessage(`Error checking rebase plan conflicts: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

        for (let i = 0; i < 32; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));

        return text;
    }

    private getWebviewContent(webview: vscode.Webview, options: any): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js')
        );

        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'rebaseEditor.css')
        );

        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Interactive git rebase</title>
    <link href="${styleUri}" rel="stylesheet" nonce="${nonce}">
</head>
<body>
    <div class="toolbar">
        <div class="button-group left">
            <button id="reset" title="Reset to original">⟳ Reset</button>
            <button id="undo" title="Undo (Ctrl+Z)">↶ Undo</button>
            <button id="redo" title="Redo (Ctrl+Y)">↷ Redo</button>
            <div class="spacer"></div>
            <button id="add-exec" title="Add exec command">⚙️ Add exec</button>
            <div class="spacer"></div>
            <button id="check">🛡️ Check conflicts</button>
            <div class="spacer"></div>
            <button id="intersect" title="File intersections">🎯 Intersections</button>
        </div>
        <div class="button-group right">
            <div class="search-controls">
                <input id="search" type="text" placeholder="Find...">
                <span id="regex-toggle" class="search-modifier" title="Toggle regex search">.*</span>
                <span id="case-toggle" class="search-modifier" title="Toggle case sensitivity">Aa</span>
            </div>
            ${options.continueMode ? '<button id="continue" class="primary">▶ Continue rebase</button>' : ''}
            <button id="abort" class="primary">🔴 Abort</button>
        </div>
    </div>
    <div class="table-wrap">
        <table>
            <colgroup>
                <col style="width: 30px">
                <col style="width:${options.actionViewKind === 'dropdown' ? '60px' : '180px'}">
                <col>
                <col id="col_author" style="width:200px">
                <col style="width:70px">
                <col style="width:80px">
                <col style="width:25px">
            </colgroup>
            <thead>
                <tr>
                    <th id="order" style="text-align: center"></th>
                    <th>Command</th>
                    <th>Message</th>
                    <th>Author</th>
                    <th>Hash</th>
                    <th>Date</th>
                    <th></th>
                </tr>
            </thead>
            <tbody id="rows"></tbody>
        </table>
    </div>
    <script nonce="${nonce}">
        let reverseOrder = ${options.reverseOrder};
        const actionViewKind = "${options.actionViewKind}";
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
