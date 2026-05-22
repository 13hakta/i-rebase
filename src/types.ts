export type Command = ('pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop' | 'exec');

export interface CommitChange {
    modification: string;
    filename: string;
}

interface SplitCommit {
    message: string;
    files: string[];
}

interface SplitInfo {
    commits: SplitCommit[];
    files: string[];
}

export interface RebaseCommand {
    hash: string;
    command: Command;
    message: string;
    author?: string;
    date?: string;
    branches?: string[];
    tags?: string[];
    hasConflict?: boolean;
    conflictFiles?: string[];
    splitted?: SplitInfo;
}

export interface GitInfo {
    author: string;
    date: string;
    branches: string[];
    tags: string[];
}

export interface TodoCommand {
    command: Command;
    hash: string;
    message: string;
    splitted?: SplitInfo;
}

export interface ShortTodoCommand {
    command: Command;
    hash: string;
}

export interface CommitInfo {
    hash: string;
    author: string;
    date: string;
    branches: string[];
    tags: string[];
}

export interface ConflictCheck {
    success: boolean;
    hash?: string;
    conflictFiles?: string[];
}
