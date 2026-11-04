import { t, locale, translateError } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { openExternalUrl, usePaseo, useRpc, type PluginButtonContentProps } from '@getpaseo/plugin/client';
import { FlatList, Icon, Modal } from '@getpaseo/plugin/client/ui';
import { deleteShare, listAllShares, type ShareLink } from '../shared/plugin';

type Colors = PluginButtonContentProps['theme']['colors'];
type Row = ShareLink & { title: string };

// GitHub asks for at least a second between mutating requests, sent serially, to avoid secondary rate limits.
const DELETE_PAUSE_MS = 1000;

function shareTime(iso: string, now = new Date()) {
  const date = new Date(iso), pad = (value: number) => String(value).padStart(2, '0');
  if (locale() === 'en') return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Checkbox({ colors, state }: { colors: Colors; state: 'on' | 'off' | 'some' }) {
  const marked = state !== 'off';
  return <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center',
    borderColor: marked ? colors.accent : colors.border, backgroundColor: marked ? colors.accent : 'transparent' }}>
    {marked && <Icon name={state === 'on' ? 'Check' : 'Minus'} size={12} color={colors.accentForeground} />}
  </View>;
}

function Action({ colors, height, label, danger, disabled, onPress }: { colors: Colors; height: number; label: string; danger?: boolean; disabled?: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={{ height, paddingHorizontal: 12, borderRadius: 6, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1, backgroundColor: danger ? colors.statusDanger : colors.surface2 }}>
    <Text numberOfLines={1} style={{ color: danger ? colors.accentForeground : colors.foreground, fontSize: 13, lineHeight: 16 }}>{label}</Text>
  </Pressable>;
}

/** The directory only names rows, so a failed read leaves links deletable under the fallback title. */
function useTitles() {
  const paseo = usePaseo();
  return async () => {
    const titles = new Map<string, string>();
    try {
      let cursor: string | undefined;
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: true, includeBackground: true }, page: { limit: 200, cursor } });
        for (const { agent } of page.entries) if (agent.title) titles.set(agent.id, agent.title);
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
    } catch { /* Keep whatever was named before the failure. */ }
    return titles;
  };
}

function ManageSharesBody({ open, colors, compact, onChanged }: { open: boolean; colors: Colors; compact: boolean; onChanged(): void }) {
  const list = useRpc(listAllShares), remove = useRpc(deleteShare), readTitles = useTitles();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string>();
  const [loadId, setLoadId] = useState(0);
  // Closing stops the batch after the request in flight, and reopening must not revive it.
  const session = useRef(0);
  const deleting = progress !== null;
  const rowHeight = compact ? 56 : 40, actionHeight = compact ? 44 : 30;

  useEffect(() => {
    if (!open) return;
    const opened = ++session.current;
    const live = () => session.current === opened;
    setRows(null); setSelected(new Set()); setConfirming(false); setError(undefined);
    void (async () => {
      const [links, titles] = await Promise.all([list({}).catch(() => ({ error: t('读取分享链接失败，请稍后重试。', 'Could not load share links. Please try again.') })), readTitles()]);
      if (!live()) return;
      if ('error' in links) { setError(translateError(links.error)); return; }
      setRows(links.links.map(link => ({ ...link, title: (link.agentId && titles.get(link.agentId)) || t('未命名会话', 'Untitled conversation') })));
    })();
    return () => { session.current++; };
  }, [open, loadId]);

  const toggle = (gistId: string) => setSelected(current => {
    const next = new Set(current);
    if (!next.delete(gistId)) next.add(gistId);
    return next;
  });

  async function deleteSelected() {
    const targets = (rows ?? []).filter(row => selected.has(row.gistId)).map(row => row.gistId);
    setConfirming(false); setError(undefined); setProgress({ done: 0, total: targets.length });
    const opened = session.current, live = () => session.current === opened;
    let done = 0;
    try {
      for (const gistId of targets) {
        if (done > 0) await new Promise(resolve => setTimeout(resolve, DELETE_PAUSE_MS));
        if (!live()) break;
        const result = await remove({ gistId }).catch(() => ({ error: t('删除失败，请稍后重试。', 'Deletion failed. Please try again.') }));
        // Every failure here is about GitHub or the token, not the row, so stop rather than repeat it.
        if ('error' in result) { if (live()) setError(translateError(result.error)); break; }
        done++;
        if (!live()) break;
        setRows(current => current?.filter(row => row.gistId !== gistId) ?? null);
        setSelected(current => { const next = new Set(current); next.delete(gistId); return next; });
        setProgress({ done, total: targets.length });
      }
    } finally {
      setProgress(null);
      if (done > 0) onChanged();
    }
  }

  const message = { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13, lineHeight: 18 };
  const count = selected.size, total = rows?.length ?? 0;
  return <View style={{ flex: 1, minHeight: 0 }}>
    {error && <View style={{ paddingBottom: 4 }}>
      <Text accessibilityRole="alert" style={{ ...message, color: colors.statusDanger }}>{error}</Text>
      {rows === null && <View style={{ paddingHorizontal: 16, alignItems: 'flex-start' }}>
        <Action colors={colors} height={actionHeight} label={t('重试', 'Retry')} onPress={() => setLoadId(id => id + 1)} />
      </View>}
    </View>}
    {rows === null ? !error && <Text style={{ ...message, color: colors.foregroundMuted }}>{t('正在读取…', 'Loading…')}</Text>
      : rows.length === 0 ? <Text style={{ ...message, color: colors.foregroundMuted }}>{t('没有分享链接', 'No share links')}</Text>
      : <>
        <View style={{ minHeight: rowHeight, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, borderBottomWidth: 1, borderColor: colors.border }}>
          {confirming ? <>
            <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{t(`删除 ${count} 个分享链接？无法恢复，链接约 5 分钟后失效。`, `Delete ${count} share link${count === 1 ? "" : "s"}? This cannot be undone. Links expire in about 5 minutes.`)}</Text>
            <Action colors={colors} height={actionHeight} label={t('取消', 'Cancel')} onPress={() => setConfirming(false)} />
            <Action colors={colors} height={actionHeight} label={t('确认删除', 'Confirm deletion')} danger onPress={() => void deleteSelected()} />
          </> : <>
            <Pressable accessibilityRole="checkbox" accessibilityLabel={t('全选', 'Select all')} accessibilityState={{ checked: count === total ? true : count > 0 ? 'mixed' : false, disabled: deleting }} disabled={deleting}
              onPress={() => setSelected(count === total ? new Set() : new Set((rows ?? []).map(row => row.gistId)))}
              style={{ flex: 1, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Checkbox colors={colors} state={count === total ? 'on' : count > 0 ? 'some' : 'off'} />
              <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{t(`全选 ${total}`, `Select all ${total}`)}</Text>
            </Pressable>
            {deleting ? <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{t(`正在删除 ${progress.done + 1}/${progress.total}`, `Deleting ${progress.done + 1}/${progress.total}`)}</Text>
              : <Action colors={colors} height={actionHeight} label={count > 0 ? t(`删除 ${count} 个`, `Delete ${count}`) : t('删除', 'Delete')} danger={count > 0} disabled={count === 0} onPress={() => setConfirming(true)} />}
          </>}
        </View>
        <FlatList style={{ flex: 1, minHeight: 0 }} data={rows} extraData={selected} keyExtractor={row => row.gistId} renderItem={({ item }) => {
          const time = shareTime(item.createdAt);
          return <View style={{ minHeight: rowHeight, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 8 }}>
            <Pressable accessibilityRole="checkbox" accessibilityLabel={t(`选择 ${item.title} ${time}`, `Select ${item.title} ${time}`)} accessibilityState={{ checked: selected.has(item.gistId), disabled: deleting || confirming }} disabled={deleting || confirming}
              onPress={() => toggle(item.gistId)} style={{ flex: 1, minWidth: 0, minHeight: rowHeight, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Checkbox colors={colors} state={selected.has(item.gistId) ? 'on' : 'off'} />
              <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 14, lineHeight: 18 }}>{item.title}</Text>
              <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{time}</Text>
            </Pressable>
            <Pressable accessibilityRole="link" accessibilityLabel={t(`打开 ${item.title} ${time}`, `Open ${item.title} ${time}`)} onPress={() => void openExternalUrl(item.url).catch(() => {})}
              style={{ width: actionHeight, height: actionHeight, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="ExternalLink" size={14} color={colors.foregroundMuted} />
            </Pressable>
          </View>;
        }} />
      </>}
  </View>;
}

export function ManageSharesModal({ open, onOpenChange, colors, compact, onChanged }: { open: boolean; onOpenChange(open: boolean): void; colors: Colors; compact: boolean; onChanged(): void }) {
  return <Modal title={t('管理分享链接', 'Manage share links')} open={open} onOpenChange={onOpenChange}>
    <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
      <ManageSharesBody open={open} colors={colors} compact={compact} onChanged={onChanged} />
    </Modal.Content>
  </Modal>;
}
