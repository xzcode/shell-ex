# Workbench V2

- Move the docked monitor to the left, full workspace height. The right workbench contains terminal tabs and the bottom tools. The monitor width, hide and native detach/dock actions remain available.
- The connection manager opens as a resizable overlay (1060 × 620 logical pixels initially). Group filters, search, a sortable/resizable table, optional columns, selection, batch move/delete, favorites and existing editor/import/export actions are available. No connection status or online marker is displayed in this manager.
- A double click always creates another independent SSH session. Tabs distinguish repeated opens; their terminal, monitor, SFTP and close operations use the session ID. Workspace restoration preserves repeated host IDs up to the existing 100-entry validation limit. Automatic reconnection follows the affected source session, not all tabs of the same host.
- The connection database and normal SFTP privilege model are unchanged. Last successful connection time, manager size and column preferences are local UI data; older backups do not include these new preferences.

## Separate privileged SFTP design (not implemented)

An explicit per-session privileged file mode must be isolated from ordinary SFTP. Investigate executing a configured server-side sftp-server path using an authorized non-interactive sudo policy, detect unsupported servers and return an actionable error, require explicit activation, and avoid persisting sudo credentials or modifying sudoers automatically. Elevated operations must be clearly distinguished, preserve correct file ownership semantics, and close the elevated channel when mode/session ends. Test permission failures, authentication restrictions, session isolation, cancellation, editor and transfer behavior before release.
