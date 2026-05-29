import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Command, CommitChange, RebaseCommand, ShortTodoCommand, CommitInfo, GitInfo, ConflictCheck, TodoCommand } from './types';

const execAsync = promisify(exec);

export class GitService {
    private cache_info = new Map<string, GitInfo>();
    private cache_files = new Map<string, string[]>();
    private workspaceRoot: string | undefined;

    constructor() {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
            this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    getWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    public clear() {
        this.cache_info.clear();
        this.cache_files.clear();
    }

    // Parse git log output in custom format
    private parseFormattedLog(stdout: string): CommitInfo[] {
        const commits: CommitInfo[] = [];
        const lines = stdout.split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;

            // Format: hash|author|date|refs
            const parts = line.split('|');
            if (parts.length < 2) continue;

            const hash = parts[0].substring(0, 8);
            const author = parts[1] || 'n/a';
            const date = parts[2] || 'n/a';
            const refsRaw = parts[3] || '';

            const branches: string[] = [];
            const tags: string[] = [];

            if (refsRaw) {
                refsRaw.split(',').forEach((ref: string) => {
                    ref = ref.trim();
                    if (!ref) return;
                    if (ref.startsWith('tag: ')) {
                        tags.push(ref.substring(5));
                    } else if (ref.startsWith('HEAD -> ')) {
                        const branchName = ref.substring(8);
                        branches.push(branchName);
                        branches.push('HEAD');
                    } else if (ref.includes(' -> ')) {
                        const [from, to] = ref.split(' -> ');
                        if (to) branches.push(to);
                        if (from) branches.push(from);
                    } else {
                        branches.push(ref);
                    }
                });
            }

            this.cache_info.set(hash,
                {
                    author,
                    date,
                    branches,
                    tags
                }
            );

            commits.push({
                hash,
                author,
                date,
                branches,
                tags
            });
        }

        return commits;
    }

    async startRebase(baseCommit: string) {
        try {
            if (!this.workspaceRoot)
                throw new Error('No workspace root found');

            await execAsync(`git rebase -i ${baseCommit}`, { cwd: this.workspaceRoot, env: {
                    ...process.env,
                    GIT_SEQUENCE_EDITOR: 'code --wait'
                }
            });
        } catch (error: any) {
            console.error('Error starting rebase:', error);
            throw error;
        }
    }

    async continueRebase() {
        try {
            if (!this.workspaceRoot)
                throw new Error('No workspace root found');

            await execAsync(`git rebase --continue`, { cwd: this.workspaceRoot, env: {
                    ...process.env,
                    GIT_SEQUENCE_EDITOR: 'code --wait'
                }
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error continuing rebase: ${error instanceof Error ? error.message : String(error)}`);
            console.error('Error continuing rebase:', error);
            throw error;
        }
    }

    async abortRebase() {
        try {
            if (!this.workspaceRoot)
                throw new Error('No workspace root found');

            await execAsync(`git rebase --abort`, { cwd: this.workspaceRoot });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error aborting rebase: ${error instanceof Error ? error.message : String(error)}`);
            console.error('Error aborting rebase:', error);
            throw error;
        }
    }

    async fetchGitInfo(hashes: string[]) {
        try {
            const hashList = hashes.join(' ');

            // %H - full hash, %an - author, %cr - date, %D - refs (branches/tags)
            const { stdout, stderr } = await execAsync(
                `git show -s --format="%h|%an|%ad|%D" ${hashList} --no-walk --date=short`,
                { cwd: this.workspaceRoot }
            )

            if (!stdout) return;

            if (stderr && !stderr.includes('warning:')) {
                console.error('Git error:', stderr);
                return null;
            }

            return this.parseFormattedLog(stdout.toString().trim());
        } catch (e) {
            console.error('Git batch fetch failed:', e);
        }
    }

    async getRebaseOnto(): Promise<string | undefined> {
        try {
            if (!this.workspaceRoot)
                return;

            // Check if .git/rebase-merge directory exists
            const { stdout } = await execAsync('git rev-parse --git-dir', { cwd: this.workspaceRoot });
            const gitDir = stdout.trim();
            const rebaseMergeDir = path.join(this.workspaceRoot, gitDir, 'rebase-merge');
            const is_rebase_active = fs.existsSync(rebaseMergeDir);

            if (is_rebase_active) {
                const ontoPath = path.join(rebaseMergeDir, 'onto');
                return fs.readFileSync(ontoPath, 'utf-8').toString().trim();
            };
        } catch (error) {
            console.error('Error checking if rebase is in progress:', error);
        }
    }

    async isRebaseStarted(): Promise<boolean> {
        try {
            if (!this.workspaceRoot)
                return false;

            // Check if .git/rebase-merge directory exists
            const { stdout } = await execAsync('git rev-parse --git-dir', { cwd: this.workspaceRoot });
            const gitDir = stdout.trim();
            const rebaseMergeDir = path.join(this.workspaceRoot, gitDir, 'rebase-merge');

            return fs.existsSync(rebaseMergeDir);
        } catch (error) {
            console.error('Error checking if rebase is in progress:', error);
            return false;
        }
    }

    async openGitRebaseTodo() {
        if (!this.workspaceRoot) {
            return;
        }

        const { stdout } = await execAsync('git rev-parse --git-dir', { cwd: this.workspaceRoot });
        const gitDir = stdout.trim();
        const todoPath = path.join(this.workspaceRoot, gitDir, 'rebase-merge', 'git-rebase-todo');
        const targetUri = vscode.Uri.file(todoPath).with({ query: 'continue' });

        try {
            // First try to open in custom editor
            await vscode.commands.executeCommand(
                'vscode.openWith', targetUri, 'irebase.gitRebaseTodoEditor'
            );
        } catch (error) {
            const document = await vscode.workspace.openTextDocument(targetUri);
            await vscode.window.showTextDocument(document);
        }
    }

    async getNthLastCommit(n: number): Promise<string | null> {
        if (!this.workspaceRoot) {
            return null;
        }

        try {
            // Try to get the nth last commit first
            const { stdout } = await execAsync(`git rev-parse HEAD~${n}`, { cwd: this.workspaceRoot });
            return stdout.trim();
        } catch (error) {
            try {
                const { stdout } = await execAsync('git rev-list --max-parents=0 HEAD', { cwd: this.workspaceRoot });
                return stdout.trim();
            } catch (error2) {
                vscode.window.showErrorMessage(`Error getting nth last commit: ${error2 instanceof Error ? error2.message : String(error2)}`);
                console.error('Error getting nth last commit:', error2);

                return null;
            }
        }
    }

    async getCommitChanges(hash: string): Promise<CommitChange[]> {
        if (!this.workspaceRoot)
            return [];

        try {
            const { stdout, stderr } = await execAsync(
                `git show --name-status --pretty=format: ${hash}`,
                { cwd: this.workspaceRoot }
            )

            if (!stdout) return [];

            if (stderr && !stderr.includes('warning:')) {
                console.error('Git error:', stderr);
                return [];
            }

            return this.parseChangeList(stdout.toString().trim());
        } catch (e) {
            console.error('Git batch fetch failed:', e);
        }

        return [];
    }

    private parseChangeList(stdout: string): CommitChange[] {
        const changes: CommitChange[] = [];
        const lines = stdout.split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;

            const parts = line.split('\t', 2);
            if (parts.length < 2) continue;

            const modification = parts[0];
            const filename = parts[1];

            changes.push({
                modification,
                filename
            });
        }

        return changes;
    }

    async parseRebaseFile(document: vscode.TextDocument) {
        const linesData: RebaseCommand[] = [];
        const missingHashes = new Set<string>();
        let skipNextExec = false;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            const trimmed = line.trim();
            if (!trimmed)
                continue;

            if (trimmed.startsWith('#')) {
                if (trimmed.startsWith('# ---split')) {
                    const splitmatch = trimmed.match(/^# ---split (.+)$/);

                    if (splitmatch) {
                        const [_, data] = splitmatch;
                        let cmd: RebaseCommand = JSON.parse(data);
                        linesData.pop();
                        linesData.push(cmd);
                        const hash = cmd.hash.substring(0, 8);
                        if (!this.cache_info.has(hash))
                            missingHashes.add(hash);

                        continue;
                    }
                } else if (trimmed === '# ---hidden-exec') {
                    // Mark that the next exec command should be skipped (it's auto-generated)
                    skipNextExec = true;
                    continue;
                } else continue;
            }

            // Match exec commands (no hash)
            const execMatch = trimmed.match(/^exec\s+(.+)$/);
            if (execMatch) {
                if (skipNextExec) {
                    // Skip hidden/auto-generated exec commands
                    skipNextExec = false;
                    continue;
                }
                const [_, execCommand] = execMatch;
                linesData.push({ command: 'exec', hash: '', message: execCommand });
                continue;
            }

            const match = trimmed.match(/^(pick|reword|edit|squash|fixup|drop)\s+(\S+)(?:\s+#?\s*(.*))?$/);

            if (match) {
                const [_, command, hashLong, message] = match;
                const hash = hashLong.substring(0, 8)
                linesData.push({ command: command as Command, hash, message });

                if (!this.cache_info.has(hash))
                    missingHashes.add(hash);
            }
        }

        if (missingHashes.size > 0) {
            await this.fetchGitInfo(Array.from(missingHashes));
        }

        return linesData.map(line => ({
            ...line,
            ...(this.cache_info.get(line.hash) || { author: 'n/a', date: 'n/a', branches: [], tags: [] })
        }));
    }

    commandsToDo(commands: TodoCommand[]): string {
        const processedCommands = []

        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            if (cmd.command === 'exec') {
                processedCommands.push(`exec ${cmd.message}`);
            }
            else if (cmd.command === 'reword') {
                // For reword commands, we use exec git commit --amend to apply the new message
                // without launching an editor
                processedCommands.push(`pick ${cmd.hash} # ${cmd.message}`);
                processedCommands.push(`# ---hidden-exec`);
                processedCommands.push(`exec git commit --amend --allow-empty -m "${cmd.message.replace(/"/g, '\\"')}"`);
            }
            else if (cmd.command === 'edit') {
                if (cmd.splitted && cmd.splitted.commits.length > 0) {
                    processedCommands.push(`pick ${cmd.hash} # ${cmd.message}`);
                    processedCommands.push(`# ---split ${JSON.stringify(cmd)}`);

                    let split_commands = ['git reset HEAD~1'];
                    for (const sc of cmd.splitted.commits) {
                        split_commands.push(`git add ${sc.files.join(' ')}`);
                        split_commands.push(`git commit -m "${sc.message.replace(/"/g, '\\"')}"`);
                    }

                    // Finishing with remaining files
                    if (cmd.splitted.files.length > 0) {
                        split_commands.push(`git add ${cmd.splitted.files.join(' ')}`);
                        split_commands.push(`git commit -m "${cmd.message}"`);
                    }

                    processedCommands.push(`# ---hidden-exec`);
                    processedCommands.push(`exec ${split_commands.join('&&')}`);
                } else processedCommands.push(`${cmd.command} ${cmd.hash} # ${cmd.message}`);
            } else processedCommands.push(`${cmd.command} ${cmd.hash} # ${cmd.message}`);
        }

        return processedCommands.join('\n') + '\n';
    }

    private async getCommitFiles(hash: string): Promise<string[]> {
        if (!this.workspaceRoot)
            return [];

        if (this.cache_files.has(hash))
            return this.cache_files.get(hash) || [];

        try {
            const { stdout, stderr } = await execAsync(
                `git show --name-only --format="" ${hash}`,
                { cwd: this.workspaceRoot }
            )

            if (!stdout) return [];

            if (stderr && !stderr.includes('warning:')) {
                console.error('Git error:', stderr);
                return [];
            }

            const files = stdout.split('\n').map(f => f.trim()).filter(Boolean);

            this.cache_files.set(hash, files);

            return files;
        } catch (e) {
            console.error('Git batch fetch failed:', e);
        }

        return [];
    }

    async findIntersections(mainHash: string, allCommits: string[]): Promise<string[]> {
        const intersections: string[] = [];
        const mainCommitFiles = await this.getCommitFiles(mainHash);

        const metaPromises = allCommits.map(async (hash) => {
            if (hash === mainHash) return;

            const files = await this.getCommitFiles(hash);
            return { hash: hash, files };
        });
        const commitFilesMap = await Promise.all(metaPromises);

        commitFilesMap.forEach(commit => {
            if (commit && commit.files.some(file => mainCommitFiles.includes(file)))
                intersections.push(commit.hash);
        });

        return intersections;
    }

    // Check if the rebase plan will have conflicts when applied in the given order.
    async checkRebasePlan(commands: ShortTodoCommand[]): Promise<ConflictCheck> {
        if (!this.workspaceRoot)
            throw new Error('No workspace root found');

        const baseCommit = await this.getRebaseOnto();
        if (!baseCommit)
            return { success: false, conflictFiles: [] };

        // Get commits to apply, preserving order, skipping 'drop'
        const commitsToApply = commands
            .filter(cmd => cmd.command !== 'drop')
            .map(cmd => cmd.hash);

        if (commitsToApply.length === 0)
            return { success: true };

        // Helper: get tree hash of a commit, returns 40-char hex or throws
        const getTreeHash = async (commit: string): Promise<string> => {
            const { stdout } = await execAsync(`git rev-parse "${commit}^{tree}"`, { cwd: this.workspaceRoot });
            const tree = stdout.trim();
            if (!tree || !/^[a-f0-9]{40}$/.test(tree)) {
                throw new Error(`Invalid tree hash for commit ${commit}`);
            }
            return tree;
        };

        const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

        // Helper: get parent tree hash (first parent) of a commit, or empty tree if no parent
        const getParentTreeHash = async (commit: string): Promise<string> => {
            let parentHash: string;
            try {
                const { stdout } = await execAsync(`git rev-parse "${commit}^1"`, { cwd: this.workspaceRoot });
                parentHash = stdout.trim();
                if (!parentHash || !/^[a-f0-9]{40}$/.test(parentHash)) {
                    // No parent (root commit) – return empty tree
                    return EMPTY_TREE;
                }
            } catch (e) {
                // No parent – return empty tree
                return EMPTY_TREE;
            }
            return getTreeHash(parentHash);
        };

        // Current tree we have after applying previous commits
        let currentTree: string;
        try {
            currentTree = await getTreeHash(baseCommit);
        } catch (e) {
            return { success: false, conflictFiles: [] };
        }

        for (let idx = 0; idx < commitsToApply.length; idx++) {
            const commitHash = commitsToApply[idx];
            let commitTree: string, parentTree: string;
            try {
                commitTree = await getTreeHash(commitHash);
                parentTree = await getParentTreeHash(commitHash);
            } catch (error) {
                return {
                    success: false,
                    hash: commitHash,
                    conflictFiles: []
                };
            }

            // Use git merge-tree --write-tree with explicit merge base
            const mergeCmd = `git merge-tree --write-tree --merge-base=${parentTree} ${currentTree} ${commitTree}`;
            let mergeStdout = '', mergeStderr = '';
            let conflictFiles: string[] = [];
            try {
                const { stdout, stderr } = await execAsync(mergeCmd, { cwd: this.workspaceRoot });
                mergeStdout = stdout;
                mergeStderr = stderr;
            } catch (error: any) {
                mergeStdout = error.stdout || '';
                mergeStderr = error.stderr || '';
            }

            // Parse conflicts from stderr (merge-tree outputs conflicts to stderr)
            const conflictRegex = /CONFLICT\s*\(([^)]+)\):\s*(?:Merge conflict in )?(.+)/;
            for (const line of mergeStderr.split('\n')) {
                const match = conflictRegex.exec(line);
                if (match) {
                    let file = match[2].trim();
                    // If file contains additional description (like "deleted in ..."), try to extract just the filename
                    const fileMatch = file.match(/^([^\s]+)/);
                    if (fileMatch)
                        file = fileMatch[1];
                    conflictFiles.push(file);
                }
            }

            if (conflictFiles.length > 0) {
                return {
                    success: false,
                    hash: commitHash,
                    conflictFiles: conflictFiles
                };
            }

            // Successful merge – stdout should contain the resulting tree hash
            const mergedTree = mergeStdout.trim();
            if (!mergedTree || !/^[a-f0-9]{40}$/.test(mergedTree)) {
                return {
                    success: false,
                    hash: commitHash,
                    conflictFiles: []
                };
            }

            currentTree = mergedTree;
        }

        return { success: true };
    }
}