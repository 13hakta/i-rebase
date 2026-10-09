// Split commit dialog - self-contained webview module.
// Loaded as a plain <script> before editor.js; exposes global `SplitDialog` object.
// Types are aliased via import() instead of a plain import statement so this file
// stays a plain script (no ES module marker `export{}` is emitted). Prefixed alias
// names avoid clashes with editor.ts aliases in the shared global script scope.
type SplitDialogCommitChange = import('../common/types').CommitChange;
type SplitDialogSplitCommit = import('../common/types').SplitCommit;
type SplitDialogSplitInfo = import('../common/types').SplitInfo;

interface SplitDialogOptions {
    title: string;
    changes: SplitDialogCommitChange[];
    existing?: SplitDialogSplitInfo;
    onSave: (result: { commits: SplitDialogSplitCommit[]; remainingFiles: string[] }) => void;
}

(function () {
    const MODIFICATIONS: { [key: string]: string } = {
        'A': 'Added',
        'M': 'Modified',
        'D': 'Deleted',
        'R': 'Renamed',
        'C': 'Copied',
        'T': 'Type Changed'
    };

    function formatChanges(changes: SplitDialogCommitChange[]): string {
        return changes.map(change => `
			<label>
				<div class="change" data-value="${escapeHtml(change.filename)}" draggable="true" title="${escapeHtml(change.filename)} — double-click to assign to the selected commit">
					<div class="file-label">
						<input type="checkbox">
						${formatFileLabel(change.filename)}
					</div>
					<div class="mod">${MODIFICATIONS[change.modification]}</div>
				</div>
			</label>`).join('');
    }

    /** Escape a string for safe interpolation into HTML */
    function escapeHtml(s: string): string {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Split a repository path into directory (with trailing slash) and file name */
    function splitFilePath(path: string): { dir: string; name: string } {
        const idx = path.lastIndexOf('/');
        if (idx === -1) return { dir: '', name: path };
        return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
    }

    /** Render a path as a prominent file name plus a muted directory part */
    function formatFileLabel(path: string): string {
        const { dir, name } = splitFilePath(path);
        const nameSpan = `<span class="file-name">${escapeHtml(name)}</span>`;
        const dirSpan = dir ? `<span class="file-path">${escapeHtml(dir)}</span>` : '';
        return nameSpan + dirSpan;
    }

    /** Auto-scroll a scrollable panel while dragging a file near its top/bottom edge */
    function setupAutoScroll(container: HTMLElement): void {
        const EDGE = 24;
        const MAX_STEP = 12;
        let scrollDelta = 0;
        let rafId = 0;

        const step = () => {
            if (scrollDelta !== 0) container.scrollTop += scrollDelta;
            rafId = requestAnimationFrame(step);
        };

        container.addEventListener('dragenter', () => {
            if (!rafId) rafId = requestAnimationFrame(step);
        });

        container.addEventListener('dragover', (e) => {
            const rect = container.getBoundingClientRect();
            const y = (e as DragEvent).clientY - rect.top;
            if (y < EDGE)
                scrollDelta = -Math.max(1, Math.min(MAX_STEP, EDGE - y));
            else if (y > rect.height - EDGE)
                scrollDelta = Math.max(1, Math.min(MAX_STEP, y - (rect.height - EDGE)));
            else
                scrollDelta = 0;
        });

        const stop = () => {
            scrollDelta = 0;
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
            }
        };

        container.addEventListener('dragleave', (e) => {
            if (!container.contains((e as DragEvent).relatedTarget as Node | null)) stop();
        });
        container.addEventListener('drop', stop);
        window.addEventListener('dragend', stop);
    }

    // Function to open the split editor dialog
    function open(options: SplitDialogOptions): void {
        let distributedFiles: string[] = [];
        let remainFiles: SplitDialogCommitChange[] = [];
        let selectedCommitIdx = -1;

        // Initialize split commits array
        const splitCommits: SplitCommit[] = (options.existing && options.existing.commits) ? [...options.existing.commits] : [];

        // Create modal dialog
        const dialog = document.createElement('dialog');
        dialog.className = 'split-editor-dialog';

        dialog.innerHTML = `
			<div class="dialog-header">
				<div class="dialog-title">Split commit: ${escapeHtml(options.title)}</div>
			</div>
			<div class="split-container">
				<div class="changes-selection">
					<button id="applyToSelectedBtn" class="primary">Assign to commit</button>
					<label>Unassigned changes:</label>
				</div>
				<div class="commit-container">
					<button id="addSplitCommitBtn" class="primary">Add commit</button>
					<label>New commits:</label>
				</div>
			</div>
			<div class="split-container2">
				<div id="changesSelect"></div>
				<div id="commitsContainer"></div>
			</div>
			<div class="buttons-panel">
				<div class="dialog-buttons">
					<button id="cancelSplitBtn">Cancel</button>
					<button id="saveSplitBtn" class="primary">💾 Save</button>
				</div>
			</div>
		`;

        document.body.appendChild(dialog);
        dialog.showModal();

        // Independent auto-scrolling panels while dragging files
        setupAutoScroll(document.getElementById('changesSelect')!);
        setupAutoScroll(document.getElementById('commitsContainer')!);

        // Prefill
        if (options.existing && options.existing.commits)
            for (const c of options.existing.commits)
                for (const f of c.files)
                    distributedFiles.push(f);
        else {
            // Templated add 2 new commits
            if (options.changes.length > 1)
                addSplitCommit();
        }

        function renderUnassignedFiles(): void {
            const container = document.getElementById('changesSelect')!;

            const excludedSet = new Set(distributedFiles);
            remainFiles = options.changes.filter(change => !excludedSet.has(change.filename));
            container.innerHTML = formatChanges(remainFiles);
        }

        // Function to render split commits
        function renderSplitCommits(): void {
            const container = document.getElementById('commitsContainer')!;

            // Preserve UI state across re-render: focus and selection
            const prevScrollTop = container.scrollTop;
            let refocusMessageIdx = -1;
            const active = document.activeElement as HTMLElement | null;
            if (active && dialog.contains(active)) {
                const entry = active.closest('.split-commit-entry');
                if (entry)
                    refocusMessageIdx = Array.from(container.children).indexOf(entry);
                if (!active.classList.contains('split-commit-message'))
                    refocusMessageIdx = -1;
            }

            container.innerHTML = '';

            splitCommits.forEach((splitCommit, idx) => {
                const commitDiv = document.createElement('div');
                commitDiv.className = 'split-commit-entry';

                commitDiv.innerHTML = `
					<div class="split-commit-header">
						<input type="text" class="split-commit-message" 
							placeholder="Commit message" required />
						<button class="up-commit">↑</button>
						<button class="down-commit">↓</button>
						<button class="remove-commit">×</button>
					</div>
					<div class="split-commit-files">
                        ${splitCommit.files.map(file => `<div class="file-item" data-value="${escapeHtml(file)}" draggable="true" title="${escapeHtml(file)}">${formatFileLabel(file)}<span class="remove-file">×</span></div>`).join('')}
					</div>
				`;

                // Set value via property to safely handle any characters in the message
                (commitDiv.querySelector('.split-commit-message') as HTMLInputElement).value = splitCommit.message;

                // Click anywhere on the card selects it as the assignment target
                commitDiv.addEventListener('click', (e) => {
                    if ((e.target as HTMLElement).closest('.remove-commit, .remove-file, .up-commit, .down-commit')) return;
                    selectedCommitIdx = idx;
                    container.querySelectorAll('.split-commit-entry').forEach(el => el.classList.remove('selected'));
                    commitDiv.classList.add('selected');
                });

                container.appendChild(commitDiv);
            });

            // Restore UI state after re-render
            container.scrollTop = prevScrollTop;
            if (selectedCommitIdx >= 0 && selectedCommitIdx < container.children.length)
                (container.children[selectedCommitIdx] as HTMLElement).classList.add('selected');
            if (refocusMessageIdx >= 0 && refocusMessageIdx < container.children.length)
                (container.children[refocusMessageIdx].querySelector('.split-commit-message') as HTMLInputElement | null)?.focus();

            // Add event listeners for remove buttons
            document.querySelectorAll('.remove-commit').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = Array.from((e.target as HTMLElement).parentElement!.parentElement!.children).indexOf((e.target as HTMLElement).parentElement!);
                    const removeSet = new Set(splitCommits[idx].files);
                    distributedFiles = distributedFiles.filter(item => !removeSet.has(item));
                    splitCommits.splice(idx, 1);

                    // Keep selection consistent with the new list
                    if (selectedCommitIdx === idx) selectedCommitIdx = -1;
                    else if (selectedCommitIdx > idx) selectedCommitIdx--;

                    renderUnassignedFiles();
                    renderSplitCommits();
                });
            });

            // Add event listeners for remove file buttons
            document.querySelectorAll('.remove-file').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const commitElement = (e.target as HTMLElement).closest('.split-commit-entry')!;
                    const commitIdx = Array.from(document.querySelectorAll('.split-commit-entry')).indexOf(commitElement);
                    const fileToRemove = ((e.target as HTMLElement).closest('.file-item') as HTMLElement)!.dataset.value!;
                    const commit = splitCommits[commitIdx];
                    if (commit) {
                        commit.files = commit.files.filter(file => file !== fileToRemove);
                        distributedFiles = distributedFiles.filter(file => file !== fileToRemove);
                        renderUnassignedFiles();
                        renderSplitCommits();
                    }
                });
            });

            // Add event listeners for message inputs
            document.querySelectorAll<HTMLInputElement>('.split-commit-message').forEach((input, idx) => {
                input.addEventListener('input', (e) => {
                    splitCommits[idx].message = (e.target as HTMLInputElement).value;

                    // Clear invalid highlighting once the message is filled in
                    if (splitCommits[idx].message.trim() !== '')
                        input.closest('.split-commit-entry')!.classList.remove('invalid');
                });

                input.addEventListener('focus', (_e) => {
                    selectedCommitIdx = idx;
                    container.querySelectorAll('.split-commit-entry').forEach(entry => {
                        entry.classList.remove('selected');
                    });
                    input.closest('.split-commit-entry')!.classList.add('selected');
                });
            });

            // Add event listeners for move up buttons
            document.querySelectorAll('.up-commit').forEach((btn, idx) => {
                btn.addEventListener('click', (_e) => {
                    if (idx > 0) { // Can't move first item up
                        // Swap current item with the previous one
                        const temp = splitCommits[idx];
                        splitCommits[idx] = splitCommits[idx - 1];
                        splitCommits[idx - 1] = temp;

                        // Re-render to reflect the new order
                        renderSplitCommits();
                    }
                });
            });

            // Add event listeners for move down buttons
            document.querySelectorAll('.down-commit').forEach((btn, idx) => {
                btn.addEventListener('click', (_e) => {
                    if (idx < splitCommits.length - 1) { // Can't move last item down
                        // Swap current item with the next one
                        const temp = splitCommits[idx];
                        splitCommits[idx] = splitCommits[idx + 1];
                        splitCommits[idx + 1] = temp;

                        // Re-render to reflect the new order
                        renderSplitCommits();
                    }
                });
            });

            // Add drag and drop functionality for files between commits
            setupFileDragAndDrop();
        }

        function setupFileDragAndDrop(): void {
            // Get all file items that are draggable
            const fileItems = document.querySelectorAll<HTMLElement>('.file-item[draggable="true"]');

            fileItems.forEach(item => {
                item.addEventListener('dragstart', (e) => {
                    (e as DragEvent).dataTransfer!.setData('text/plain', item.dataset.value!);
                    (e as DragEvent).dataTransfer!.effectAllowed = 'move';
                });
            });

            // Get all drop zones (commit file containers)
            const dropZones = document.querySelectorAll<HTMLElement>('.split-commit-files');

            dropZones.forEach(zone => {
                zone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    (e as DragEvent).dataTransfer!.dropEffect = 'move';
                    zone.classList.add('drop-target');
                });

                zone.addEventListener('dragleave', (_e) => {
                    zone.classList.remove('drop-target');
                });

                zone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    zone.classList.remove('drop-target');

                    const fileName = (e as DragEvent).dataTransfer!.getData('text/plain');

                    // Find the commit container for this zone
                    const commitEntry = zone.closest('.split-commit-entry')!;
                    const commitIndex = Array.from(document.querySelectorAll('.split-commit-entry')).indexOf(commitEntry);

                    if (commitIndex !== -1) {
                        // Remove file from its current location
                        removeFileFromAllCommits(fileName);

                        // Add file to the target commit
                        if (!splitCommits[commitIndex].files.includes(fileName)) {
                            splitCommits[commitIndex].files.push(fileName);

                            // Update distributed files list
                            if (!distributedFiles.includes(fileName)) {
                                distributedFiles.push(fileName);
                            }
                        }

                        // Re-render the UI
                        renderUnassignedFiles();
                        renderSplitCommits();
                    }
                });
            });

            // Also allow dropping files from unassigned changes area
            const unassignedArea = document.getElementById('changesSelect');
            if (unassignedArea) {
                unassignedArea.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    (e as DragEvent).dataTransfer!.dropEffect = 'move';
                });

                unassignedArea.addEventListener('drop', (e) => {
                    e.preventDefault();

                    const fileName = (e as DragEvent).dataTransfer!.getData('text/plain');

                    // Find the selected commit to move the file to
                    const selectedCommitElement = document.querySelector('.split-commit-entry.selected');
                    if (selectedCommitElement) {
                        const commitIndex = Array.from(document.querySelectorAll('.split-commit-entry')).indexOf(selectedCommitElement);

                        if (commitIndex !== -1) {
                            // Add file to the selected commit
                            if (!splitCommits[commitIndex].files.includes(fileName)) {
                                splitCommits[commitIndex].files.push(fileName);

                                // Update distributed files list
                                if (!distributedFiles.includes(fileName)) {
                                    distributedFiles.push(fileName);
                                }
                            }

                            // Re-render the UI
                            renderUnassignedFiles();
                            renderSplitCommits();
                        }
                    }
                });
            }

            // Add drag support for unassigned files
            const unassignedFileItems = document.querySelectorAll<HTMLElement>('#changesSelect .change');
            unassignedFileItems.forEach(item => {
                item.addEventListener('dragstart', (e) => {
                    (e as DragEvent).dataTransfer!.setData('text/plain', item.dataset.value!);
                    (e as DragEvent).dataTransfer!.effectAllowed = 'move';
                });
            });
        }

        function removeFileFromAllCommits(fileName: string): void {
            for (const commit of splitCommits) {
                const index = commit.files.indexOf(fileName);
                if (index > -1)
                    commit.files.splice(index, 1);
            }

            // Also remove from distributed files if no longer in any commit
            const stillExists = splitCommits.some(commit => commit.files.includes(fileName));
            if (!stillExists) {
                const index = distributedFiles.indexOf(fileName);
                if (index > -1)
                    distributedFiles.splice(index, 1);
            }
        }

        function addSplitCommit(): void {
            splitCommits.push({
                message: options.title + ' #' + (splitCommits.length + 1),
                files: []
            });
        }

        // Add commit button
        document.getElementById('addSplitCommitBtn')!.addEventListener('click', () => {
            addSplitCommit();
            renderSplitCommits();
        });

        // Apply files to selected commit button
        document.getElementById('applyToSelectedBtn')!.addEventListener('click', () => {
            const selectedCommitElement = document.querySelector('.split-commit-entry.selected') ||
                document.querySelector('.split-commit-entry');
            if (!selectedCommitElement) return;

            const commitIdx = Array.from(document.querySelectorAll('.split-commit-entry')).indexOf(selectedCommitElement);
            if (commitIdx === -1) return;

            const selectedFiles = Array.from(document.querySelectorAll<HTMLInputElement>('#changesSelect input[type="checkbox"]:checked'))
                .map(checkbox => checkbox.closest('.change')!.getAttribute('data-value')!);

            // Add selected files to the commit (avoiding duplicates)
            selectedFiles.forEach(file => {
                if (!splitCommits[commitIdx].files.includes(file)) {
                    splitCommits[commitIdx].files.push(file);
                    distributedFiles.push(file);
                }
            });

            renderUnassignedFiles();
            renderSplitCommits();
        });

        // Double-click on an unassigned file assigns it to the selected commit
        document.getElementById('changesSelect')!.addEventListener('dblclick', (e) => {
            const changeEl = (e.target as HTMLElement).closest('.change');
            if (!changeEl) return;

            const fileName = changeEl.getAttribute('data-value');
            if (!fileName) return;

            // Reuse the same target resolution as the "Assign to commit" button
            const selectedCommitElement = document.querySelector('.split-commit-entry.selected') ||
                document.querySelector('.split-commit-entry');
            if (!selectedCommitElement) return;

            const commitIdx = Array.from(document.querySelectorAll('.split-commit-entry')).indexOf(selectedCommitElement);
            if (commitIdx === -1) return;

            if (!splitCommits[commitIdx].files.includes(fileName)) {
                splitCommits[commitIdx].files.push(fileName);
                distributedFiles.push(fileName);
            }

            renderUnassignedFiles();
            renderSplitCommits();
        });

        dialog.addEventListener("close", (_event) => {
            document.body.removeChild(dialog);
        });

        // Save button
        document.getElementById('saveSplitBtn')!.addEventListener('click', () => {
            // Block saving when a commit has files but no message
            let hasInvalid = false;
            let focusedInvalid = false;
            document.querySelectorAll('.split-commit-entry').forEach((entry, idx) => {
                const invalid = splitCommits[idx].files.length > 0 && splitCommits[idx].message.trim() === '';
                entry.classList.toggle('invalid', invalid);
                if (invalid) {
                    hasInvalid = true;
                    if (!focusedInvalid) {
                        (entry.querySelector('.split-commit-message') as HTMLInputElement).focus();
                        focusedInvalid = true;
                    }
                }
            });
            if (hasInvalid) return;

            // Update the caller with the split commits.
            // Commits without assigned files are ignored - only non-empty splits make sense.
            options.onSave({
                commits: splitCommits.filter(c => c.files.length > 0),
                remainingFiles: remainFiles.map(f => f.filename)
            });

            dialog.close();
        });

        // Cancel button
        document.getElementById('cancelSplitBtn')!.addEventListener("click", () => {
            dialog.close();
        });

        // Initial render
        renderUnassignedFiles();
        renderSplitCommits();
    }

    (window as unknown as { SplitDialog: { open(options: SplitDialogOptions): void } }).SplitDialog = { open };
})();
