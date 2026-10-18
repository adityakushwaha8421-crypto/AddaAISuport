/**
 * Folder edits run one at a time, across filing AND removal. Telegram rewrites the whole folder on
 * every edit (read the folder, write it back), so two edits in flight at once overwrite each other:
 * a human's reply that lands while the agent is still filing the chat would read "not in the folder",
 * do nothing, and then the filing would write the chat in — leaving a handled chat in the folder.
 * One queue for both makes a removal always see the filing it follows.
 */
export class FolderEdits {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
