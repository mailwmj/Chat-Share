import type { PluginClientContext } from '@getpaseo/plugin/client';

type WorkspaceDirectory = Awaited<ReturnType<PluginClientContext['paseo']['workspaces']['list']>>;
type WorkspaceSubscription = NonNullable<WorkspaceDirectory['subscription']>;
type SessionOutboundMessage = Parameters<Parameters<WorkspaceSubscription['subscribe']>[0]['update']>[0];

interface Page<Entry> {
  entries: Entry[];
  pageInfo: { nextCursor: string | null };
  subscription?: {
    subscribe(observer: { snapshot(page: Page<Entry>): void; update(message: SessionOutboundMessage): void; error(error: unknown): void }): unknown;
    release(): Promise<void>;
  };
}

/** Both directories page at 200. Queue live changes until all snapshot pages arrive. */
export function observeDirectory<Entry>(
  list: (cursor: string | undefined, subscribe: boolean) => Promise<Page<Entry>>,
  observer: { snapshot(entries: Entry[]): void; update(message: SessionOutboundMessage): void; error(): void },
): () => void {
  let disposed = false, generation = 0;
  let subscription: Page<Entry>['subscription'];
  let buffered: SessionOutboundMessage[] | null = null;
  void list(undefined, true).then(initial => {
    subscription = initial.subscription!;
    if (disposed) { void subscription.release(); return; }
    subscription.subscribe({
      snapshot: first => {
        const current = ++generation;
        buffered = [];
        void (async () => {
          const entries = [...first.entries];
          let cursor = first.pageInfo.nextCursor;
          while (cursor) {
            const page = await list(cursor, false);
            if (disposed || current !== generation) return;
            entries.push(...page.entries); cursor = page.pageInfo.nextCursor;
          }
          if (disposed || current !== generation) return;
          observer.snapshot(entries);
          const changes = buffered!; buffered = null;
          for (const message of changes) observer.update(message);
        })().catch(() => { if (!disposed && current === generation) { buffered = null; observer.error(); } });
      },
      update: message => {
        if (disposed) return;
        if (buffered) buffered.push(message); else observer.update(message);
      },
      error: () => { if (!disposed) observer.error(); },
    });
  }).catch(() => { if (!disposed) observer.error(); });
  return () => { disposed = true; generation++; void subscription?.release(); };
}
