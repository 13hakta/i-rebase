import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Command, CommitChange, RebaseCommand, ShortTodoCommand, CommitInfo, GitInfo, ConflictCheck, TodoCommand } from '../common/types';

const execFileAsync = promisify(execFile);

// Object id of the empty tree - used as the "parent" of root commits
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function sequenceEditor(): string {
    return process.platform === 'win32' ? 'code.cmd --wait' : 'code --wait';
}

const outputChannel = vscode.window.createOutputChannel('I-Rebase');

export type GitErrorKind = 'dirty-tree' | 'rebase-in-progress' | 'conflict' | 'no-upstream' | 'aborted' | 'generic';

export interface GitErrorInfo {
    kind: GitErrorKind;
    message: string;
}

// Extract meaningful error text from git command failure
function extractGitMessage(error: any): string {
    const raw = [error?.stderr, error?.stdout, error?.message]
        .map((v) => (v ? String(v) : ''))
        .join('\n');

    const important = raw.split('\n').filter((line) =>
        /(^|\s)(fatal|error|CONFLICT|hint):/i.test(line) || /cannot rebase|already a rebase|could not apply/i.test(line)
    );

    if (important.length > 0)
        return important.map((l) => l.trim()).join('\n');

    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.length > 0 ? lines[lines.length - 1] : 'Unknown git error';
}

// Classify a git error into a well-known scenario
export function classifyGitError(error: any): GitErrorInfo {
    const raw = [error?.stderr, error?.stdout, error?.message]
        .map((v) => (v ? String(v) : ''))
        .join('\n');

    if (/already a rebase-merge|rebase-apply|rebase in progress/i.test(raw))
        return { kind: 'rebase-in-progress', message: extractGitMessage(error) };

    if (/cannot rebase:|unstaged changes|uncommitted changes|your local changes|index does not match/i.test(raw))
        return { kind: 'dirty-tree', message: extractGitMessage(error) };

    if (/CONFLICT|could not apply/i.test(raw))
        return { kind: 'conflict', message: extractGitMessage(error) };

    if (/no upstream configured|no configured push destination|has no upstream/i.test(raw))
        return { kind: 'no-upstream', message: extractGitMessage(error) };

    // User aborted the rebase from the todo editor while the sequence editor
    // was still attached: git can no longer read the removed todo file - this is benign
    if (/could not read file .*git-rebase-todo|there was a problem with the editor|No such file or directory.*git-rebase-todo/i.test(raw))
        return { kind: 'aborted', message: extractGitMessage(error) };

    return { kind: 'generic', message: extractGitMessage(error) };
}

// Show the I-Rebase output channel
export function showGitLog() {
    outputChannel.show();
}

// Log full git error details to the I-Rebase output channel
export function logGitError(context: string, error: any) {
    const details = [error?.stderr, error?.stdout, error instanceof Error ? error.stack || error.message : String(error)]
        .map((v) => (v ? String(v) : ''))
        .filter((v) => v.length > 0)
        .join('\n');

    outputChannel.appendLine(`[${new Date().toISOString()}] ${context}\n${details}\n`);
}


export class GitService {
    private cache_info = new Map<string, GitInfo>();
    private cache_files = new Map<string, string[]>();
    private cache_full = new Map<string, string>();
    // Incremental state of the last conflict-check simulation: plan - full hashes
    // already merged in order; prefixTrees[i] - accumulated tree after applying
    // the first i+1 commits; baseRef - commit the simulation started from.
    private check_state?: { baseRef: string; plan: string[]; prefixTrees: string[] };
    private workspaceRoot: string | undefined;

    constructor() {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
            this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    getWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    private async getGitDir(): Promise<string | undefined> {
        if (!this.workspaceRoot)
            return undefined;

        const { stdout } = await this.runGit(['rev-parse', '--git-dir']);
        const gitDir = stdout.trim().replace(/^"|"$/g, '');

        return path.isAbsolute(gitDir) ? gitDir : path.join(this.workspaceRoot, gitDir);
    }

    // Run git without a shell
    private runGit(args: string[], maxBuffer: number = 10 * 1024 * 1024) {
        return execFileAsync('git', args, {
            cwd: this.workspaceRoot,
            maxBuffer
        });
    }

    // Public passthrough for collaborators outside the class (e.g. diff UI)
    runGitPublic(args: string[], maxBuffer: number = 10 * 1024 * 1024) {
        return this.runGit(args, maxBuffer);
    }

    public clear() {
        this.cache_info.clear();
        this.cache_files.clear();
        this.cache_full.clear();
        this.check_state = undefined;
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

            await execFileAsync('git', ['rebase', '-i', baseCommit], {
                cwd: this.workspaceRoot,
                maxBuffer: 10 * 1024 * 1024,
                env: {
                    ...process.env,
                    GIT_SEQUENCE_EDITOR: sequenceEditor()
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

            await execFileAsync('git', ['rebase', '--continue'], {
                cwd: this.workspaceRoot,
                maxBuffer: 10 * 1024 * 1024,
                env: {
                    ...process.env,
                    GIT_SEQUENCE_EDITOR: sequenceEditor()
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

            await this.runGit(['rebase', '--abort']);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error aborting rebase: ${error instanceof Error ? error.message : String(error)}`);
            console.error('Error aborting rebase:', error);
            throw error;
        }
    }

    async fetchGitInfo(hashes: string[]) {
        try {
            // %h - short hash, %an - author, %ad - date, %D - refs (branches/tags)
            const { stdout, stderr } = await this.runGit(
                ['show', '-s', '--format=%h|%an|%ad|%D', '--no-walk', '--date=short', ...hashes]
            );

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

            // Check if rebase-merge directory exists inside the git dir
            const gitDir = await this.getGitDir();
            if (!gitDir)
                return;

            const rebaseMergeDir = path.join(gitDir, 'rebase-merge');
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

            // Check if rebase-merge directory exists inside the git dir
            const gitDir = await this.getGitDir();
            if (!gitDir)
                return false;

            const rebaseMergeDir = path.join(gitDir, 'rebase-merge');

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

        const gitDir = await this.getGitDir();
        if (!gitDir)
            return;

        const todoPath = path.join(gitDir, 'rebase-merge', 'git-rebase-todo');
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

    // Resolve an arbitrary refspec (branch, tag, hash, HEAD~N) to a commit hash
    async validateRef(ref: string): Promise<string | null> {
        if (!this.workspaceRoot || !ref.trim())
            return null;

        try {
            const { stdout } = await this.runGit(['rev-parse', '--verify', '--quiet', `${ref.trim()}^{commit}`]);
            const hash = stdout.trim();
            return hash || null;
        } catch (error) {
            return null;
        }
    }

    // Get the merge base of HEAD and its push/upstream ref -
    // the commit from which all not-yet-pushed local commits start
    async getUpstreamMergeBase(): Promise<string | null> {
        if (!this.workspaceRoot)
            return null;

        for (const ref of ['@{push}', '@{upstream}']) {
            try {
                const { stdout } = await this.runGit(['merge-base', 'HEAD', ref]);
                const hash = stdout.trim();
                if (hash)
                    return hash;
            } catch (error) {
                logGitError(`getUpstreamMergeBase(${ref}) failed`, error);
            }
        }

        vscode.window.showErrorMessage('No upstream or push remote is configured for the current branch');
        return null;
    }

    // Stash local changes (including untracked files)
    async stashChanges(): Promise<boolean> {
        if (!this.workspaceRoot)
            return false;

        try {
            await this.runGit(['stash', '-u']);
            return true;
        } catch (error) {
            logGitError('Failed to stash changes', error);
            const info = classifyGitError(error);
            vscode.window.showErrorMessage(`Failed to stash changes: ${info.message}`);
            return false;
        }
    }

    async getNthLastCommit(n: number): Promise<string | null> {
        if (!this.workspaceRoot) {
            return null;
        }

        try {
            // Try to get the nth last commit first
            const { stdout } = await this.runGit(['rev-parse', `HEAD~${n}`]);
            return stdout.trim();
        } catch (error) {
            try {
                const { stdout } = await this.runGit(['rev-list', '--max-parents=0', 'HEAD']);
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
            const { stdout, stderr } = await this.runGit(
                ['show', '--name-status', '--pretty=format:', hash]
            );

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

            const parts = line.split('\t');
            if (parts.length < 2) continue;

            const modification = parts[0];
            const isRenameOrCopy = /^[RC]/.test(modification) && parts.length >= 3;
            const filename = isRenameOrCopy ? parts[2] : parts[1];

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

    private shellQuote(value: string): string {
        return `'${value.replace(/'/g, `'\\''`)}'`;
    }

    private quoteFiles(files: string[]): string {
        return files.map(f => this.shellQuote(f)).join(' ');
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
                processedCommands.push(`exec git commit --amend --allow-empty -m ${this.shellQuote(cmd.message)}`);
            }
            else if (cmd.command === 'edit') {
                if (cmd.splitted && cmd.splitted.commits.length > 0) {
                    processedCommands.push(`pick ${cmd.hash} # ${cmd.message}`);
                    processedCommands.push(`# ---split ${JSON.stringify(cmd)}`);

                    let split_commands = ['git reset HEAD~1'];
                    for (const sc of cmd.splitted.commits) {
                        split_commands.push(`git add -A -- ${this.quoteFiles(sc.files)}`);
                        split_commands.push(`git commit -m ${this.shellQuote(sc.message)}`);
                    }

                    // Finishing with remaining files
                    if (cmd.splitted.files && cmd.splitted.files.length > 0) {
                        split_commands.push(`git add -A -- ${this.quoteFiles(cmd.splitted.files)}`);
                        split_commands.push(`git commit -m ${this.shellQuote(cmd.message)}`);
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

        // Normalize to the full hash first: single lookups come with short hashes
        // from the webview, while batch results are cached under full ones - one
        // shared key format keeps the cache consistent.
        const full = await this.resolveFullHash(hash);

        if (this.cache_files.has(full))
            return this.cache_files.get(full) || [];

        try {
            const { stdout, stderr } = await this.runGit(
                ['show', '--name-only', '--format=', full]
            );

            if (!stdout) return [];

            if (stderr && !stderr.includes('warning:')) {
                console.error('Git error:', stderr);
                return [];
            }

            const files = stdout.split('\n').map(f => f.trim()).filter(Boolean);

            this.cache_files.set(full, files);

            return files;
        } catch (e) {
            console.error('Git batch fetch failed:', e);
        }

        return [];
    }

    // Fetch changed files for many commits in a few batched git calls.
    // Output format: a "%H" hash line followed by one file path per line.
    private async getCommitFilesBatch(hashes: string[]): Promise<Map<string, string[]>> {
        const result = new Map<string, string[]>();

        // Serve from cache first
        const pending: string[] = [];
        for (const hash of hashes) {
            const cached = this.cache_files.get(hash);
            if (cached)
                result.set(hash, cached);
            else
                pending.push(hash);
        }

        const CHUNK_SIZE = 100;
        for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
            const chunk = pending.slice(i, i + CHUNK_SIZE);

            try {
                const { stdout, stderr } = await this.runGit(
                    ['log', '--no-walk', '--format=%H', '--name-only', ...chunk]
                );

                if (stderr && !stderr.includes('warning:'))
                    console.error('Git error:', stderr);

                let currentHash = '';
                for (const line of stdout.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    if (/^[a-f0-9]{40}$/.test(trimmed)) {
                        currentHash = trimmed;
                        result.set(currentHash, []);
                    } else if (currentHash) {
                        result.get(currentHash)!.push(trimmed);
                    }
                }
            } catch (e) {
                console.error('Git batch files fetch failed:', e);
            }
        }

        // Cache whatever was resolved
        for (const [hash, files] of result) {
            if (!this.cache_files.has(hash))
                this.cache_files.set(hash, files);
        }

        return result;
    }

    async findIntersections(mainHash: string, allCommits: string[]): Promise<string[]> {
        const mainCommitFiles = await this.getCommitFiles(mainHash);
        const mainFileSet = new Set(mainCommitFiles);

        const others = allCommits.filter(h => h !== mainHash);
        const filesByHash = await this.getCommitFilesBatch(others);

        // Full hash -> the id the caller passed (short form from the webview)
        const idByFull = new Map<string, string>();
        for (const id of allCommits)
            idByFull.set(await this.resolveFullHash(id), id);
        const fullMain = await this.resolveFullHash(mainHash);

        const intersections: string[] = [];
        for (const [hash, files] of filesByHash) {
            if (hash === fullMain)
                continue;
            if (files.some(file => mainFileSet.has(file))) {
                const id = idByFull.get(hash);
                if (id)
                    intersections.push(id);
            }
        }

        return intersections;
    }

    // Full 40-char hash of a commit, used to normalize cache keys below.
    // Unresolvable ids map to themselves so callers never see a throw.
    private async resolveFullHash(hash: string): Promise<string> {
        const cached = this.cache_full.get(hash);
        if (cached)
            return cached;

        try {
            const { stdout } = await this.runGit(['rev-parse', '--verify', '--quiet', `${hash}^{commit}`]);
            const full = stdout.trim();
            if (/^[a-f0-9]{40}$/.test(full)) {
                this.cache_full.set(hash, full);
                return full;
            }
        } catch (e) {
            // fall through
        }

        this.cache_full.set(hash, hash);
        return hash;
    }

    // Changed-file entries of a commit: {status, oldPath, path} per file
    async getCommitDiffFiles(hash: string): Promise<Array<{ status: string; oldPath?: string; path: string }>> {
        const { stdout } = await this.runGit([
            'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', hash
        ]);
        const files: Array<{ status: string; oldPath?: string; path: string }> = [];

        for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            const parts = line.split('\t');
            if (parts[0].startsWith('R') || parts[0].startsWith('C')) {
                if (parts.length >= 3)
                    files.push({ status: parts[0][0], oldPath: parts[1], path: parts[2] });
            } else if (parts.length >= 2) {
                files.push({ status: parts[0], path: parts[1] });
            }
        }

        return files;
    }

    // File content at a given commit for the firebase: content provider
    async getCommitFileContent(commit: string, filePath: string): Promise<string> {
        const { stdout } = await this.runGit(['show', `${commit}:${filePath}`]);
        return stdout;
    }

    // Check if the rebase plan will have conflicts when applied in the given order.
    async checkRebasePlan(commands: ShortTodoCommand[]): Promise<ConflictCheck> {
        if (!this.workspaceRoot)
            throw new Error('No workspace root found');

        const baseCommit = await this.getRebaseOnto();
        if (!baseCommit)
            return { success: false, conflictFiles: [], error: 'Cannot determine the rebase base commit' };

        let baseRef = baseCommit;
        try {
            const gitDir = await this.getGitDir();
            if (gitDir) {
                const donePath = path.join(gitDir, 'rebase-merge', 'done');
                if (fs.existsSync(donePath)) {
                    const done = fs.readFileSync(donePath, 'utf-8');
                    if (done.split('\n').some(line => line.trim().length > 0 && !line.startsWith('#'))) {
                        const { stdout } = await this.runGit(['rev-parse', 'HEAD']);
                        const head = stdout.trim();
                        if (head && /^[a-f0-9]{40}$/.test(head))
                            baseRef = head;
                    }
                }
            }
        } catch (e) {
            // Fall back to onto if anything cannot be resolved
        }

        // Get commits to apply, preserving order, skipping 'drop'
        const commitsToApplyRaw = commands
            .filter(cmd => cmd.command !== 'drop')
            .map(cmd => cmd.hash);

        if (commitsToApplyRaw.length === 0)
            return { success: true };

        // Hashes coming from the todo editor may be abbreviated (the webview uses %h).
        // Resolve them to full 40-char hashes in a single batch, otherwise lookups
        // against full hashes returned by rev-list would fail.
        let commitsToApply: string[];
        try {
            const { stdout } = await this.runGit(['rev-parse', ...commitsToApplyRaw]);
            const resolved = stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0);
            if (resolved.length !== commitsToApplyRaw.length || resolved.some(h => !/^[a-f0-9]{40}$/.test(h)))
                throw new Error('Unexpected rev-parse output');
            commitsToApply = resolved;
        } catch (error) {
            return {
                success: false,
                conflictFiles: [],
                error: 'Cannot resolve hashes of the rebase plan commits'
            };
        }

        // Helper: get tree hash of a commit, returns 40-char hex or throws
        const getTreeHash = async (commit: string): Promise<string> => {
            const { stdout } = await this.runGit(['rev-parse', `${commit}^{tree}`]);
            const tree = stdout.trim();
            if (!tree || !/^[a-f0-9]{40}$/.test(tree)) {
                throw new Error(`Invalid tree hash for commit ${commit}`);
            }
            return tree;
        };

        const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

        // Current tree we have after applying previous commits.
        // Resume from the cached prefix if the base and the plan's beginning are
        // unchanged since the last check - re-simulating identical commits would
        // just repeat the same merges, so only the suffix starting at the first
        // difference is re-checked. Merge simulation is deterministic: the same
        // base + same commit sequence always yields the same accumulated tree.
        let currentTree: string;
        let startIdx = 0;
        const cached = this.check_state;
        if (cached && cached.baseRef === baseRef) {
            // Resume only within the verified prefix: prefixTrees holds the
            // accumulated tree per simulated commit and is shorter than the plan
            // when the previous run stopped on a conflict - positions beyond it
            // were never simulated and must be re-checked.
            const shared = Math.min(cached.prefixTrees.length, commitsToApply.length);
            let common = 0;
            while (common < shared && cached.plan[common] === commitsToApply[common])
                common++;

            if (common > 0)
                startIdx = common;
        }

        try {
            // Cached tree unavailable or malformed – fall back to a full simulation
            if (startIdx > 0 && /^[a-f0-9]{40}$/.test(this.check_state!.prefixTrees[startIdx - 1]))
                currentTree = this.check_state!.prefixTrees[startIdx - 1];
            else {
                startIdx = 0;
                currentTree = await getTreeHash(baseRef);
            }
        } catch (e) {
            return { success: false, conflictFiles: [], error: `Cannot resolve tree of the base commit ${baseRef}` };
        }
        const resumedPrefix = startIdx;

        // Batch-resolve trees of all commits in a single git call (instead of one rev-parse per commit)
        const commitTrees = new Map<string, string>();
        try {
            const { stdout } = await this.runGit(['rev-parse', ...commitsToApply.map(h => `${h}^{tree}`)]);
            const trees = stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0);
            if (trees.length !== commitsToApply.length || trees.some(t => !/^[a-f0-9]{40}$/.test(t)))
                throw new Error('Unexpected rev-parse output');
            commitsToApply.forEach((h, i) => commitTrees.set(h, trees[i]));
        } catch (error) {
            return {
                success: false,
                conflictFiles: [],
                error: 'Cannot resolve trees of the rebase plan commits'
            };
        }

        // Batch-resolve parents of all commits in a single git call.
        // Root commits simply have no parent entry in the rev-list output.
        const parentMap = new Map<string, string[]>();
        try {
            const { stdout } = await this.runGit(['rev-list', '--parents', '--no-walk', ...commitsToApply]);
            for (const line of stdout.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length === 0 || !parts[0])
                    continue;
                parentMap.set(parts[0], parts.slice(1));
            }
        } catch (error) {
            return {
                success: false,
                conflictFiles: [],
                error: 'Cannot resolve parents of the rebase plan commits'
            };
        }

        // Batch-resolve trees of all unique parents
        const uniqueParents = [...new Set(commitsToApply.flatMap(h => parentMap.get(h) ?? []))];
        const parentTrees = new Map<string, string>();
        if (uniqueParents.length > 0) {
            try {
                const { stdout } = await this.runGit(['rev-parse', ...uniqueParents.map(h => `${h}^{tree}`)]);
                const trees = stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0);
                if (trees.length !== uniqueParents.length || trees.some(t => !/^[a-f0-9]{40}$/.test(t)))
                    throw new Error('Unexpected rev-parse output');
                uniqueParents.forEach((h, i) => parentTrees.set(h, trees[i]));
            } catch (error) {
                return {
                    success: false,
                    conflictFiles: [],
                    error: 'Cannot resolve parent trees of the rebase plan commits'
                };
            }
        }

        // Accumulated trees per position (suffix only when resumed); saved for the
        // next incremental check
        const prefixTrees = this.check_state && resumedPrefix > 0
            ? this.check_state.prefixTrees.slice(0, resumedPrefix)
            : [];

        // Persist the verified prefix even when the suffix fails: the next check
        // resumes from the same position instead of re-merging from the start.
        const saveState = () => {
            this.check_state = { baseRef, plan: commitsToApply, prefixTrees };
        };

        for (let idx = resumedPrefix; idx < commitsToApply.length; idx++) {
            const commitHash = commitsToApply[idx];
            const commitTree = commitTrees.get(commitHash)!;
            // No parent (root commit) – use empty tree as merge base
            const parents = parentMap.get(commitHash) ?? [];
            const parentTree = parents.length > 0 ? parentTrees.get(parents[0])! : EMPTY_TREE;

            if (parentTree === currentTree) {
                currentTree = commitTree;
                prefixTrees.push(commitTree);
                continue;
            }

            // Requires git >= 2.40.
            let mergeStdout = '';
            let exitCode = 0;
            try {
                const { stdout } = await this.runGit([
                    'merge-tree', '--write-tree', '--name-only', '--no-messages',
                    `--merge-base=${parentTree}`, currentTree, commitTree
                ]);
                mergeStdout = stdout;
            } catch (error: any) {
                exitCode = typeof error.code === 'number' ? error.code : 1;
                mergeStdout = error.stdout || '';
            }

            if (exitCode === 0) {
                // Successful merge – stdout contains the resulting tree hash
                const mergedTree = mergeStdout.trim();
                if (!mergedTree || !/^[a-f0-9]{40}$/.test(mergedTree)) {
                    return {
                        success: false,
                        hash: commitHash,
                        conflictFiles: [],
                        error: `Unexpected merge-tree output for commit ${commitHash}`
                    };
                }
                currentTree = mergedTree;
                prefixTrees.push(mergedTree);
                continue;
            }

            if (exitCode !== 1) {
                // Any exit code other than 0 (clean) or 1 (conflicts) means the merge itself failed
                return {
                    success: false,
                    hash: commitHash,
                    conflictFiles: [],
                    error: `git merge-tree failed for commit ${commitHash}`
                };
            }

            // Conflicts: first line is the (partial) merged tree, then a blank line
            // and the list of conflicted file paths, one per line
            const lines = mergeStdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const conflictFiles = lines.filter(l => !/^[a-f0-9]{40}$/.test(l));

            saveState();

            return {
                success: false,
                hash: commitHash,
                conflictFiles: conflictFiles
            };
        }

        saveState();

        return { success: true };
    }
}