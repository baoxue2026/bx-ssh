export function shouldSkipApplicationShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return true;
  if (event.shiftKey) return false;

  const target = event.target;
  return (
    target instanceof Element && target.closest(".terminal-container") !== null
  );
}
