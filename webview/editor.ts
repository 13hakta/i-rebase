// Script run within the webview itself.
// Types are aliased via import() instead of a plain import statement so this file
// stays a plain script (no ES module marker `export{}` is emitted).
type Command = import('../common/types').Command;
type CommitChange = import('../common/types').CommitChange;
type SplitCommit = import('../common/types').SplitCommit;
type SplitInfo = import('../common/types').SplitInfo;

// --- Types ---

interface VsCodeApi {
    postMessage(message: Record<string, unknown>): void;
    getState(): WebViewState | undefined;
    setState(state: WebViewState): void;
}

interface WebViewState {
    commits: Commit[];
}

interface CmdDef {
    v: Command;
    short: string;
    full: string;
}

// Webview-side view model: extends the shared commit data with UI-only flags.
interface Commit {
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
    main?: boolean;
    dependant?: boolean;
}

interface RowFlag {
    moved: boolean;
    cmdChanged: boolean;
}

// Global object exposed by splitDialog.js (loaded before editor.js)
declare const SplitDialog: {
    open(options: {
        title: string;
        changes: CommitChange[];
        existing?: SplitInfo;
        onSave: (result: { commits: SplitCommit[]; remainingFiles: string[] }) => void;
    }): void;
};

interface PostMessageUpdate {
    type: 'update';
    commits: Commit[];
}

interface PostMessageRequestContent {
    type: 'requestContent';
}

interface PostMessageConflictFound {
    type: 'conflictFound';
    hash: string;
    conflictFiles: string[];
}

interface PostMessageCommitChanges {
    type: 'commitChanges';
    hash: string;
    changes: CommitChange[];
}

interface PostMessagePerformReset {
    type: 'performReset';
}

interface PostMessageClearConflicts {
    type: 'clearConflicts';
}

interface PostMessageIntersections {
    type: 'intersections';
    hash: string;
    intersections: string[];
}

type WebviewMessage =
    | PostMessageUpdate
    | PostMessageRequestContent
    | PostMessageConflictFound
    | PostMessageCommitChanges
    | PostMessagePerformReset
    | PostMessageClearConflicts
    | PostMessageIntersections;

// Messages sent from the webview to the extension
interface OutgoingOpenDiff extends Record<string, unknown> {
    type: 'openDiff';
    hash: string;
}

// --- Globals injected by inline script in HTML ---
declare let reverseOrder: boolean;
declare const actionViewKind: string;
declare const autoCheckConflicts: boolean;

// --- VS Code API ---
declare function acquireVsCodeApi(): VsCodeApi;

(function () {
    const vscode = acquireVsCodeApi();

    const rowsContainer = document.getElementById('rows') as HTMLElement;

    // JavaScript functionality for the table
    const CMDS: Command[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
    const CMD_DEFS: CmdDef[] = [
        { v: 'pick', short: 'P', full: 'Pick' },
        { v: 'reword', short: 'R', full: 'Reword' },
        { v: 'edit', short: 'E', full: 'Edit' },
        { v: 'squash', short: 'S', full: 'Squash' },
        { v: 'fixup', short: 'F', full: 'Fixup' },
        { v: 'drop', short: 'D', full: 'Drop' }
    ];

    // Track currently selected row index
    let selectedRowIndex: number = -1;
    let rows: Commit[] = [];
    let initialRows: Commit[] = [];
    let originalMessages: Map<string, string> = new Map();

    // Search functionality
    let searchQuery: string = '';
    let useRegex: boolean = false;
    let caseSensitive: boolean = false;
    let searchPattern: RegExp | null = null;

    // Undo/redo stacks
    const undoStack: string[] = [];
    const redoStack: string[] = [];
    const MAX_HISTORY: number = 50;


    function toggleOrder(): void {
        reverseOrder = !reverseOrder;
        vscode.postMessage({ type: 'changeOrder', order: reverseOrder });
        orderBtn.textContent = reverseOrder ? '▼' : '▲';

        initialRows.reverse();
        rows.reverse();

        // Keep the selection on the same commit
        if (selectedRowIndex >= 0)
            selectedRowIndex = rows.length - 1 - selectedRowIndex;

        render();
    }

    function resetHistory(): void {
        // Perform the actual reset operation
        rows = structuredClone(initialRows);
        redoStack.length = 0;
        undoStack.length = 0;

        updateDirtyState();
        resetFlags();
        render();
    }

    function pushState(): void {
        undoStack.push(JSON.stringify(rows));
        if (undoStack.length > MAX_HISTORY) undoStack.shift();
        redoStack.length = 0;
        updateDirtyState();
        vscode.postMessage({ type: 'changed' });
        scheduleAutoConflictCheck();
    }

    // Debounced silent conflict check after every plan change (optional setting)
    let autoCheckTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleAutoConflictCheck(): void {
        if (!autoCheckConflicts)
            return;

        if (autoCheckTimer !== undefined)
            clearTimeout(autoCheckTimer);

        autoCheckTimer = setTimeout(() => {
            autoCheckTimer = undefined;
            checkConflicts(true);
        }, 500);
    }

    function reset(): void {
        vscode.postMessage({ type: 'confirmReset' });
    }

    function addExecCommand(): void {
        pushState();
        const insertIndex = selectedRowIndex >= 0 ? selectedRowIndex + 1 : rows.length;
        const execRow: Commit = {
            command: 'exec',
            hash: '',
            message: '',
            author: '',
            date: '',
            branches: [],
            tags: []
        };
        rows.splice(insertIndex, 0, execRow);
        selectedRowIndex = insertIndex;
        resetFlags();
        render();
    }

    function removeExecCommand(index: number): void {
        if (index < 0 || index >= rows.length) return;
        if (rows[index].command !== 'exec') return;

        pushState();
        rows.splice(index, 1);

        // Adjust selection after removal
        if (selectedRowIndex === index) {
            selectedRowIndex = Math.min(index, rows.length - 1);
        } else if (selectedRowIndex > index) {
            selectedRowIndex--;
        }

        resetFlags();
        render();
    }

    function findIntersections(): void {
        const intersectBtn = document.getElementById('intersect')!;

        // Unpress button
        if (intersectBtn.classList.contains('pressed')) {
            intersectBtn.classList.remove('pressed');

            rows.forEach(commit => {
                commit.main = false;
                commit.dependant = false;
            });

            render();
            return;
        }

        if (selectedRowIndex === -1) return;
        const commit = rows[selectedRowIndex];

        // Exec commands have no hash, can't find intersections
        if (commit.command === 'exec') return;

        vscode.postMessage({ type: 'findIntersections', hash: commit.hash, all_commits: rows.filter(c => c.command !== 'exec').map(c => c.hash) });
        document.getElementById('intersect')!.classList.add('pressed');
    }

    function updateDirtyState(): void {
        (document.getElementById('reset') as HTMLButtonElement).disabled = undoStack.length === 0;
        (document.getElementById('undo') as HTMLButtonElement).disabled = undoStack.length === 0;
        (document.getElementById('redo') as HTMLButtonElement).disabled = redoStack.length === 0;
    }

    function undo(): void {
        if (undoStack.length === 0) return;
        redoStack.push(JSON.stringify(rows));
        rows = JSON.parse(undoStack.pop()!);

        // Reset conflict flags after undo since the order might have changed
        updateDirtyState();
        resetFlags();
        render();
    }

    function redo(): void {
        if (redoStack.length === 0) return;
        undoStack.push(JSON.stringify(rows));
        rows = JSON.parse(redoStack.pop()!);

        // Reset conflict flags after redo since the order might have changed
        updateDirtyState();
        resetFlags();
        render();
    }

    function saveContent(): void {
        const commands: { command: Command; hash: string; message: string; splitted?: SplitInfo }[] = [];

        const orderedRows = (reverseOrder) ? [...rows].reverse() : rows;

        for (const commit of orderedRows) {
            commands.push({
                command: commit.command,
                hash: commit.hash,
                message: commit.message,
                splitted: commit.splitted
            });
        }

        vscode.postMessage({ type: 'saveContent', commands: commands });
    }

    // Function to reset conflict flags for all commits
    function resetFlags(): void {
        rows.forEach(commit => {
            commit.hasConflict = false;
            commit.conflictFiles = [];
        });
    }

    function checkConflicts(silent: boolean = false): void {
        const commands: { command: Command; hash: string }[] = [];

        const orderedRows = (reverseOrder) ? [...rows].reverse() : rows;

        for (const commit of orderedRows) {
            // Skip exec commands — they have no hash and can't conflict
            if (commit.command === 'exec') continue;
            commands.push({
                command: commit.command,
                hash: commit.hash
            });
        }

        vscode.postMessage({ type: 'checkConflicts', commands: commands, silent: silent });
    }

    function markConflictingCommit(hash: string, conflictFiles: string[]): void {
        const commit = rows.find(c => hash.startsWith(c.hash) || c.hash.startsWith(hash));
        if (!commit)
            return;

        commit.hasConflict = true;
        commit.conflictFiles = structuredClone(conflictFiles);

        render();
    }

    function markIntersections(hash: string, intersections: string[]): void {
        resetFlags();

        const commit = rows.find(c => c.hash === hash)!;
        commit.main = true;

        rows.map(r => {
            if (intersections.includes(r.hash))
                r.dependant = true;
        });
    }

    function rowStateFlags(cur: Commit[], initOrder: Commit[]): RowFlag[] {
        const initPos = new Map(initOrder.map((x, i) => [x.hash, i]));
        const initCmd = new Map(initOrder.map((x) => [x.hash, String(x.command).toLowerCase()]));

        return cur.map((r, i) => ({
            moved: initPos.get(r.hash) !== i,
            cmdChanged: initCmd.get(r.hash) !== String(r.command).toLowerCase()
        }));
    }

    function performSearch(): void {
        const searchInput = document.getElementById('search') as HTMLInputElement;
        searchQuery = searchInput.value.trim();

        // Clear previous highlights
        rowsContainer.querySelectorAll('tr').forEach(el => {
            el.classList.remove('highlight');
        });

        if (!searchQuery) {
            searchPattern = null;
            render(); // Re-render without highlighting
            return;
        }

        // Prepare search pattern based on settings
        if (useRegex) {
            try {
                searchPattern = new RegExp(searchQuery, caseSensitive ? 'g' : 'gi');
            } catch (_e) {
                // Invalid regex, skip highlighting
                searchPattern = null;
            }
        } else {
            // Escape special regex characters for literal search
            const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searchPattern = new RegExp(escapedQuery, caseSensitive ? 'g' : 'gi');
        }

        // Re-render with highlighting
        render();
    }

    function setContent(commits: Commit[]): void {
        const copy = structuredClone(commits);
        if (reverseOrder)
            copy.reverse();

        rows = copy;
        initialRows = structuredClone(copy);

        let authorMaxLen = 0;

        // Store original commit messages separately — never modified, used for restoring text
        originalMessages = new Map(rows.map(r => {
            authorMaxLen = Math.max(authorMaxLen, (r.author || '').length);
            return [r.hash, r.message];
        }));

        document.getElementById('col_author')!.style.width = (Math.ceil(authorMaxLen / 2) + 2) + 'em';

        render();
    }

    function requestsplitEditor(index: number): void {
        // Get the selected commit
        const commit = rows[index];
        vscode.postMessage({ type: 'commitChanges', hash: commit.hash });
    }

    // Function to open the split editor dialog
    function splitEditor(hash: string, changes: CommitChange[]): void {
        const commit = rows.find(c => c.hash === hash);

        if (!commit) return;

        SplitDialog.open({
            title: commit.message,
            changes,
            existing: commit.splitted,
            onSave: (result) => {
                pushState();
                commit.splitted = {
                    commits: result.commits
                };
                if (result.remainingFiles.length > 0)
                    commit.splitted.files = result.remainingFiles;

                resetFlags(); // Reset flags when files are reassigned during split
                render(); // Refresh the main table to show the split commits
            }
        });
    }

    function render(): void {
        if (!rowsContainer) return;

        // Create floating dropdown container if it doesn't exist
        let floatingDropdown = document.getElementById('floating-action-dropdown');
        if (!floatingDropdown) {
            floatingDropdown = document.createElement('div');
            floatingDropdown.id = 'floating-action-dropdown';
            floatingDropdown.className = 'action-dropdown-menu';
            document.body.appendChild(floatingDropdown);
        }

        // Clear any existing items in the floating dropdown
        floatingDropdown.innerHTML = '';

        rowsContainer.innerHTML = '';
        const flags = rowStateFlags(rows, initialRows);
        rows.forEach((r, uiIndex) => {
            const tr = document.createElement('tr');
            tr.dataset.index = String(uiIndex);
            tr.dataset.command = r.command;

            // Add highlight class to row if any element was highlighted
            if (searchPattern && r.message && r.message.match(searchPattern))
                tr.classList.add('highlight');

            if (r.main)
                tr.classList.add('main');

            if (r.dependant)
                tr.classList.add('dependant');

            // Add selected class if this is the currently selected row
            if (uiIndex === selectedRowIndex)
                tr.classList.add('selected');

            // Add conflict class if this row has conflicts
            if (r.hasConflict)
                tr.classList.add('conflict');

            const f = flags[uiIndex];
            if (f.moved) tr.classList.add('pos-changed'); // Changed position
            if (f.cmdChanged) tr.classList.add('cmd-changed');

            // Drag handle cell
            const tdHandle = document.createElement('td');
            tdHandle.style.width = '20px';
            tdHandle.style.padding = '0 2px';
            const dragHandle = document.createElement('div');
            dragHandle.className = 'drag-handle';
            dragHandle.textContent = '⠿';

            // Only add drag event listeners to the handle, not the whole row
            dragHandle.draggable = true;
            dragHandle.addEventListener('dragstart', (e) => {
                e.dataTransfer!.setData('text/plain', String(uiIndex));
                e.dataTransfer!.effectAllowed = 'move';
            });

            tdHandle.appendChild(dragHandle);

            // Exec commands get special rendering
            if (r.command === 'exec') {
                tr.classList.add('exec-row');

                // Command cell — just show "exec" label
                const tdCmd = document.createElement('td');
                tdCmd.textContent = 'Execute';

                // Message cell — editable input for shell command, spans across message+author columns
                const tdMsg = document.createElement('td');
                tdMsg.colSpan = 3;
                const execInput = document.createElement('input');
                execInput.type = 'text';
                execInput.className = 'exec-input';
                execInput.value = r.message || '';
                execInput.placeholder = 'Shell command';
                if (uiIndex === selectedRowIndex) {
                    requestAnimationFrame(() => {
                        execInput.focus();
                    });
                }
                execInput.addEventListener('change', (_e) => {
                    pushState();
                    rows[uiIndex].message = execInput.value;
                });
                execInput.addEventListener('blur', (_e) => {
                    if (rows[uiIndex].message !== execInput.value) {
                        pushState();
                        rows[uiIndex].message = execInput.value;
                    }
                });
                execInput.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
                tdMsg.appendChild(execInput);

                // Remove button for exec commands
                const tdClear = document.createElement('td');
                const removeBtn = document.createElement('button');
                removeBtn.className = 'remove-exec-btn';
                removeBtn.textContent = '🗑️';
                removeBtn.title = 'Remove exec command';
                removeBtn.ariaLabel = 'Remove exec command';
                removeBtn.addEventListener('click', () => removeExecCommand(uiIndex));
                tdClear.appendChild(removeBtn);

                // Actions cell
                const tdAct = document.createElement('td');
                tdAct.className = 'action-group';
                const moveButtons = document.createElement('div');
                moveButtons.className = 'move-btns';
                const up = document.createElement('button');
                up.className = 'move-btn';
                up.textContent = '▲';
                up.ariaLabel = 'Move up';
                up.disabled = uiIndex === 0;
                up.addEventListener('click', () => move(uiIndex, uiIndex - 1));
                const down = document.createElement('button');
                down.textContent = '▼';
                down.ariaLabel = 'Move down';
                down.disabled = uiIndex === rows.length - 1;
                down.addEventListener('click', () => move(uiIndex, uiIndex + 1));
                moveButtons.appendChild(up);
                moveButtons.appendChild(down);
                tdAct.appendChild(moveButtons);

                tr.appendChild(tdHandle);
                tr.appendChild(tdCmd);
                tr.appendChild(tdMsg);
                tr.appendChild(tdClear);
                tr.appendChild(tdAct);

                tr.addEventListener('click', (e) => {
                    if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).className.includes('drag-handle')) {
                        return;
                    }
                    selectRow(uiIndex);
                });

                rowsContainer.appendChild(tr);
                return; // Skip normal commit rendering
            }

            // Command cell
            const tdCmd = document.createElement('td');

            if (actionViewKind === 'dropdown') {
                // Create a dropdown-style action selector using div elements instead of select
                const actionSelector = document.createElement('div');
                actionSelector.className = 'action-selector';
                actionSelector.tabIndex = 0; // Make it focusable

                // Create element to display current command as a button-like element with just the first letter
                const currentAction = document.createElement('div');
                currentAction.className = 'current-action-btn cmd-' + r.command.toLowerCase();
                const cmdDef = CMD_DEFS.find(def => def.v === r.command.toLowerCase());
                currentAction.textContent = cmdDef ? cmdDef.full : 'Pick'; // Display the full form of the command
                currentAction.title = cmdDef ? cmdDef.full : 'Pick';

                // Show dropdown on hover over the current action button
                // Show floating dropdown when mouse enters the current action button
                currentAction.addEventListener('mouseenter', (_e) => {
                    // Populate the floating dropdown with command options
                    floatingDropdown!.innerHTML = '';

                    CMD_DEFS.forEach((def) => {
                        const menuItem = document.createElement('div');
                        menuItem.className = 'action-menu-item';
                        menuItem.textContent = def.full;
                        menuItem.dataset.command = def.v;

                        // Highlight current command
                        if (def.v === r.command.toLowerCase()) {
                            menuItem.classList.add('selected');
                        }

                        menuItem.addEventListener('click', () => {
                            pushState();
                            rows[uiIndex].command = def.v;

                            // Update the display of the current action to show the full form of the new command
                            const newCmdDef = CMD_DEFS.find(d => d.v === def.v);
                            currentAction.textContent = newCmdDef ? newCmdDef.full : 'Pick';
                            currentAction.title = newCmdDef ? newCmdDef.full : 'Pick';
                            currentAction.className = 'current-action-btn cmd-' + def.v;

                            render(); // Re-render with current search pattern
                            floatingDropdown!.style.display = 'none'; // Hide dropdown after selection
                        });

                        floatingDropdown!.appendChild(menuItem);
                    });

                    // Position the floating dropdown above the current action button
                    const rect = currentAction.getBoundingClientRect();
                    floatingDropdown!.style.top = (rect.top + window.scrollY - floatingDropdown!.offsetHeight) + 'px';
                    floatingDropdown!.style.left = (rect.left + window.scrollX) + 'px';
                    floatingDropdown!.style.display = 'block';
                });

                // Add mouseleave handler to hide dropdown with a delay
                currentAction.addEventListener('mouseleave', (e) => {
                    // Use a small timeout to allow moving to the dropdown menu
                    setTimeout(() => {
                        // Check if mouse is now over the floating dropdown
                        const mouseOverDropdown = e.relatedTarget && floatingDropdown!.contains(e.relatedTarget as Node);
                        if (!mouseOverDropdown) {
                            floatingDropdown!.style.display = 'none';
                        }
                    }, 200);
                });

                // Add mouseenter to the floating dropdown to prevent hiding when hovering over it
                floatingDropdown.addEventListener('mouseenter', () => {
                    clearTimeout(hideTimeoutId);
                });

                // Add mouseleave to the floating dropdown to hide it when leaving
                let hideTimeoutId: ReturnType<typeof setTimeout>;
                floatingDropdown.addEventListener('mouseleave', (_e) => {
                    hideTimeoutId = setTimeout(() => {
                        floatingDropdown!.style.display = 'none';
                    }, 200);
                });

                // Allow keyboard navigation
                currentAction.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        // Show the floating dropdown at the position of the current action
                        const rect = currentAction.getBoundingClientRect();
                        floatingDropdown!.style.top = (rect.top + window.scrollY - floatingDropdown!.offsetHeight) + 'px';
                        floatingDropdown!.style.left = (rect.left + window.scrollX) + 'px';
                        floatingDropdown!.style.display = 'block';
                        // Focus the first item in the dropdown for keyboard navigation
                        if (floatingDropdown!.firstChild) {
                            (floatingDropdown!.firstChild as HTMLElement).focus();
                        }
                    }
                });

                actionSelector.appendChild(currentAction);
                tdCmd.appendChild(actionSelector);
            } else {
                // Original button-based implementation
                const curCmd = CMDS.includes(String(r.command).toLowerCase() as Command) ? String(r.command).toLowerCase() : 'pick';
                const group = document.createElement('div');
                group.className = 'cmd-group';
                group.setAttribute('role', 'group');
                group.setAttribute('aria-label', 'Command');

                CMD_DEFS.forEach((def) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = `cmd-btn cmd-${def.v}` + (curCmd === def.v ? ' active' : '');
                    b.textContent = def.short;
                    b.title = def.full;
                    b.setAttribute('aria-label', def.full);
                    b.setAttribute('aria-pressed', curCmd === def.v ? 'true' : 'false');
                    b.addEventListener('click', () => {
                        pushState();
                        rows[uiIndex].command = def.v;
                        render(); // Re-render with current search pattern
                    });
                    group.appendChild(b);
                });
                tdCmd.appendChild(group);
            }

            // Message cell
            const tdMsg = document.createElement('td');

            if (r.command === 'edit') {
                const split = document.createElement('button');
                split.textContent = '✂️';
                split.className = 'cut-btn';
                split.addEventListener('click', () => requestsplitEditor(uiIndex));
                tdMsg.appendChild(split);
            }

            const badges = document.createElement('span');
            badges.className = 'badges';
            (r.branches || []).forEach(lb => {
                const b = document.createElement('div');
                b.className = 'badge branch';
                b.textContent = lb;
                badges.appendChild(b);
            });
            (r.tags || []).forEach(lb => {
                const b = document.createElement('div');
                b.className = 'badge tag';
                b.textContent = lb;
                badges.appendChild(b);
            });
            tdMsg.appendChild(badges);

            // Create input field for reword command, span for others
            let subjectElement: HTMLElement;
            if (r.command === 'reword') {
                const inputEl = document.createElement('input');
                inputEl.type = 'text';
                inputEl.className = 'subject-input';
                inputEl.placeholder = 'Commit message';
                inputEl.value = r.message || '';
                // Focus the input after render so user can type immediately
                // Only focus if this is currently selected row
                if (uiIndex === selectedRowIndex) {
                    requestAnimationFrame(() => {
                        inputEl.focus();
                        inputEl.select();
                    });
                }
                inputEl.addEventListener('change', (_e) => {
                    pushState();
                    rows[uiIndex].message = inputEl.value;
                });
                inputEl.addEventListener('blur', (_e) => {
                    if (rows[uiIndex].message !== inputEl.value) {
                        pushState();
                        rows[uiIndex].message = inputEl.value;
                    }
                });
                // Prevent propagation of click events to avoid row selection when clicking input
                inputEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
                subjectElement = inputEl;
            } else {
                // When not in reword mode, reset to original message
                const originalMessage = originalMessages.get(r.hash) || r.message || '';
                // Update the row's subject to the original message if it was modified in reword mode
                if (r.message !== originalMessage) {
                    rows[uiIndex].message = originalMessage;
                }
                const spanEl = document.createElement('span');
                spanEl.className = 'subject';
                spanEl.textContent = originalMessage;
                subjectElement = spanEl;
            }
            tdMsg.appendChild(subjectElement);

            // Author cell
            const tdAuthor = document.createElement('td');
            const authorEl = document.createElement('div');
            authorEl.textContent = r.author || '';
            tdAuthor.appendChild(authorEl);

            // Hash cell with potential highlighting; click opens the commit diff
            const tdHash = document.createElement('td');
            const hashEl = document.createElement('div');
            hashEl.className = 'hash hash-link';
            const hashText = (r.hash || '').slice(0, 8);
            hashEl.textContent = hashText;
            hashEl.title = 'Open commit diff: ' + (r.hash || '');
            hashEl.addEventListener('click', (e) => {
                e.stopPropagation(); // keep row selection unchanged
                if (r.hash)
                    vscode.postMessage({ type: 'openDiff', hash: r.hash } as OutgoingOpenDiff);
            });
            tdHash.appendChild(hashEl);

            // Date cell
            const tdDate = document.createElement('td');
            const dateEl = document.createElement('div');
            dateEl.className = 'date';
            dateEl.textContent = r.date || '';
            tdDate.appendChild(dateEl);

            // Actions cell
            const tdAct = document.createElement('td');
            tdAct.className = 'action-group';
            tdAct.setAttribute('role', 'group');
            tdAct.setAttribute('aria-label', 'Action');

            const moveButtons = document.createElement('div');
            moveButtons.className = 'move-btns';

            const up = document.createElement('button');
            up.className = 'move-btn';
            up.textContent = '▲';
            up.ariaLabel = 'Move up';
            up.disabled = uiIndex === 0;
            up.addEventListener('click', () => move(uiIndex, uiIndex - 1));

            const down = document.createElement('button');
            down.textContent = '▼';
            down.ariaLabel = 'Move down';
            down.disabled = uiIndex === rows.length - 1;
            down.addEventListener('click', () => move(uiIndex, uiIndex + 1));

            moveButtons.appendChild(up);
            moveButtons.appendChild(down);
            tdAct.appendChild(moveButtons);

            // Add cells
            tr.appendChild(tdHandle);
            tr.appendChild(tdCmd);
            tr.appendChild(tdMsg);
            tr.appendChild(tdAuthor);
            tr.appendChild(tdHash);
            tr.appendChild(tdDate);
            tr.appendChild(tdAct);

            // Add click event to select the row
            tr.addEventListener('click', (e) => {
                // Don't select if clicking on buttons or drag handle
                if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).className.includes('drag-handle')) {
                    return;
                }
                selectRow(uiIndex);
            });

            rowsContainer.appendChild(tr);

            if ((r.command === 'edit') && r.splitted && r.splitted.commits) {
                for (const commit of r.splitted.commits) {
                    const trSplitted = document.createElement('tr');
                    trSplitted.className = 'splitted';

                    const tdEmpty = document.createElement('td');
                    tdEmpty.colSpan = 2;

                    const tdMessage = document.createElement('td');
                    tdMessage.textContent = commit.message;
                    tdMessage.colSpan = 2;

                    const tdAmount = document.createElement('td');
                    tdAmount.textContent = `${commit.files.length} file(s)`;
                    tdAmount.colSpan = 3;

                    trSplitted.appendChild(tdEmpty);
                    trSplitted.appendChild(tdMessage);
                    trSplitted.appendChild(tdAmount);
                    rowsContainer.appendChild(trSplitted);
                }
            }

            if (r.hasConflict && r.conflictFiles && r.conflictFiles.length > 0) {
                const trConflicts = document.createElement('tr');
                trConflicts.className = 'conflicts';

                const tdSignMark = document.createElement('td');
                tdSignMark.textContent = '⚠';
                tdSignMark.className = 'error-sign';

                const tdConflictMark = document.createElement('td');
                tdConflictMark.textContent = 'Files';

                const tdConflictDescription = document.createElement('td');
                tdConflictDescription.colSpan = 5;

                tdConflictDescription.textContent = (r.conflictFiles as string[]).join(', ');

                trConflicts.appendChild(tdSignMark);
                trConflicts.appendChild(tdConflictMark);
                trConflicts.appendChild(tdConflictDescription);
                rowsContainer.appendChild(trConflicts);
            }
        });
    }

    function move(from: number, to: number): void {
        if (to < 0 || to >= rows.length) return;

        pushState();
        const copy = rows.slice();
        const [it] = copy.splice(from, 1);
        copy.splice(to, 0, it);
        rows = copy;

        // Reset flags for all commits after moving
        resetFlags();

        // Update selection after move
        if (selectedRowIndex === from) {
            selectedRowIndex = to;
        } else if (selectedRowIndex > from && selectedRowIndex <= to) {
            selectedRowIndex--;
        } else if (selectedRowIndex < from && selectedRowIndex >= to) {
            selectedRowIndex++;
        }
        render();
    }

    function dragMove(from: number, to: number): void {
        if (Number.isNaN(from)) return;
        if (to < 0 || to > rows.length) return;
        if (from === to) return;

        const copy = rows.slice();
        const [it] = copy.splice(from, 1);
        let insert = to;
        if (from < to) insert -= 1;
        if (insert < 0) insert = 0;
        if (insert > copy.length) insert = copy.length;
        pushState();
        copy.splice(insert, 0, it);
        rows = copy;

        // Reset flags for all commits after dragging
        resetFlags();

        // Update selection after drag move
        if (selectedRowIndex === from) {
            selectedRowIndex = to;
        } else if (selectedRowIndex > from && selectedRowIndex <= to) {
            selectedRowIndex--;
        } else if (selectedRowIndex < from && selectedRowIndex >= to) {
            selectedRowIndex++;
        }
        render();
    }

    // Function to select a row by index
    function selectRow(index: number): void {
        if (index >= 0 && index < rows.length) {
            selectedRowIndex = index;
            render();
        }
    }

    // Function to cycle through command options
    function cycleCommand(rowIndex: number, direction: number): void {
        if (rowIndex < 0 || rowIndex >= rows.length) {
            return;
        }

        const currentCmd = rows[rowIndex].command.toLowerCase();
        let currentIndex = CMDS.indexOf(currentCmd as Command);

        if (currentIndex === -1) {
            currentIndex = 0; // Default to first command if current command not found
        }

        // Cycle forward or backward
        currentIndex += direction;
        if (currentIndex >= CMDS.length) {
            currentIndex = 0;
        } else if (currentIndex < 0) {
            currentIndex = CMDS.length - 1;
        }

        rows[rowIndex].command = CMDS[currentIndex];

        render();
    }

    // Add keyboard event listener
    document.addEventListener('keydown', (e) => {
        // Undo: Ctrl+Z or Cmd+Z
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
            return;
        }
        // Redo: Ctrl+Y or Cmd+Shift+Z
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
            e.preventDefault();
            redo();
            return;
        }

        if (selectedRowIndex === -1) return; // No row selected

        switch (e.key) {
            case 'ArrowUp':
                e.preventDefault();
                // Move selection up
                if (selectedRowIndex > 0)
                    selectRow(selectedRowIndex - 1);
                break;

            case 'ArrowDown':
                e.preventDefault();
                // Move selection down
                if (selectedRowIndex < rows.length - 1)
                    selectRow(selectedRowIndex + 1);
                break;

            case 'ArrowLeft':
                if (!e.ctrlKey) break;
                e.preventDefault();
                // Cycle command backward (P->D->F->S->E->R->P...)
                cycleCommand(selectedRowIndex, -1);
                break;

            case 'ArrowRight':
                if (!e.ctrlKey) break;
                e.preventDefault();
                // Cycle command forward (P->R->E->S->F->D->P...)
                cycleCommand(selectedRowIndex, 1);
                break;
        }
    });

    function clearDropHints(): void {
        document.querySelectorAll('tr.drop-before, tr.drop-after').forEach(tr => {
            tr.classList.remove('drop-before', 'drop-after');
        });
    }

    const orderBtn = document.getElementById('order')!;
    orderBtn.textContent = reverseOrder ? '▼' : '▲';
    (orderBtn as HTMLElement).style.cursor = 'pointer';
    orderBtn.addEventListener('click', toggleOrder);

    document.getElementById('check')!.addEventListener('click', () => checkConflicts());

    // Add search functionality
    document.getElementById('search')!.addEventListener('input', performSearch);

    // Add toggle for regex mode
    document.getElementById('regex-toggle')!.addEventListener('click', e => {
        useRegex = !useRegex;
        (e.target as HTMLElement).classList.toggle('active', useRegex);
        performSearch();
    });

    // Add toggle for case sensitivity
    document.getElementById('case-toggle')!.addEventListener('click', e => {
        caseSensitive = !caseSensitive;
        (e.target as HTMLElement).classList.toggle('active', caseSensitive);
        performSearch();
    });

    document.getElementById('undo')!.addEventListener('click', undo);
    document.getElementById('redo')!.addEventListener('click', redo);
    document.getElementById('reset')!.addEventListener('click', reset);

    document.getElementById('intersect')!.addEventListener('click', findIntersections);

    document.getElementById('add-exec')!.addEventListener('click', addExecCommand);

    document.getElementById('abort')!.addEventListener('click', () => {
        vscode.postMessage({ type: 'abortRebase' });
    });

    const continueButton = document.getElementById('continue');

    if (continueButton) {
        continueButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'saveContinue' });
        });
    }

    // Drop position is defined as an insertion gap index (0..rows.length):
    // 0 = above the first row, k = below row k-1. "Before row i" and "after row i-1"
    // are the same gap, so the indicator is drawn once per gap: 'drop-before'
    // above the first row or 'drop-after' below a row.
    interface DropPosition {
        index: number;
        row: HTMLElement;
        before: boolean;
    }

    function getDropPosition(mouseY: number): DropPosition | null {
        const allRows = Array.from(rowsContainer.querySelectorAll<HTMLElement>('tr:not(.splitted)'));
        if (allRows.length === 0) return null;

        // Boundary candidates: above the first row and below every row
        const boundaries = [{ index: 0, y: allRows[0].getBoundingClientRect().top }];
        allRows.forEach((row, i) => {
            boundaries.push({ index: i + 1, y: row.getBoundingClientRect().bottom });
        });

        let best = boundaries[0];
        for (const b of boundaries) {
            if (Math.abs(mouseY - b.y) < Math.abs(mouseY - best.y))
                best = b;
        }

        if (best.index === 0)
            return { index: 0, row: allRows[0], before: true };
        return { index: best.index, row: allRows[best.index - 1], before: false };
    }

    // Global drag and drop handlers
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        // Handle drags only when the pointer is over the commit table
        let target: HTMLElement | null = e.target as HTMLElement;
        while (target && target !== document.body) {
            if (target.tagName === 'TR' && target.closest('tbody#rows')) {
                break;
            }
            target = target.parentElement;
        }

        if (target && target.tagName === 'TR') {
            e.dataTransfer!.dropEffect = 'move';
            clearDropHints();

            const pos = getDropPosition(e.clientY);
            if (!pos) return;

            pos.row.classList.add(pos.before ? 'drop-before' : 'drop-after');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        clearDropHints();

        const fromIndex = parseInt(e.dataTransfer!.getData('text/plain'), 10);
        if (isNaN(fromIndex) || fromIndex < 0 || fromIndex >= rows.length) return;

        // Handle drops only when the pointer is over the commit table
        let target: HTMLElement | null = e.target as HTMLElement;
        while (target && target !== document.body) {
            if (target.tagName === 'TR' && target.closest('tbody#rows')) {
                break;
            }
            target = target.parentElement;
        }

        if (target && target.tagName === 'TR') {
            const pos = getDropPosition(e.clientY);
            if (!pos) return;

            dragMove(fromIndex, pos.index);
        }
    });

    window.addEventListener('dragend', () => clearDropHints());

    updateDirtyState();

    // Restore state
    const state = vscode.getState();
    if (state)
        setContent(state.commits);

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data as WebviewMessage;

        switch (message.type) {
            case 'update':
                setContent(message.commits);
                vscode.setState({ commits: message.commits });
                break;
            case 'requestContent':
                saveContent();
                break;
            case 'conflictFound':
                markConflictingCommit(message.hash, message.conflictFiles);
                break;
            case 'commitChanges':
                splitEditor(message.hash, message.changes);
                break;
            case 'performReset':
                resetHistory();
                break;
            case 'clearConflicts':
                resetFlags();
                render();
                break;
            case 'intersections':
                markIntersections(message.hash, message.intersections);
                render();
                break;
        }
    });
}());