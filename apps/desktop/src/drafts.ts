const dirtyDrafts = new Set<string>();
export function setDraftDirty(id: string, dirty: boolean) {
  if (dirty) dirtyDrafts.add(id);
  else dirtyDrafts.delete(id);
}
export function hasDirtyDrafts() {
  return dirtyDrafts.size > 0;
}
