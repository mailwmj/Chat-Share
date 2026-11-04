import { t, locale, translateError } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { openExternalUrl, usePaseo, useRpc, type PluginButtonContentProps } from '@getpaseo/plugin/client';
import { Icon, Modal, ScrollView } from '@getpaseo/plugin/client/ui';
import { deleteShare, listAllShares, type ShareLink } from '../shared/plugin';

type Colors = PluginButtonContentProps['theme']['colors'];
type Row = ShareLink & { title: string };

// GitHub asks for at least a second between mutating requests, sent serially, to avoid secondary rate limits.
const DELETE_PAUSE_MS = 1000;
// Lines the body up with the title the host draws in the dialog header.
const INSET = 24;
// A longer list scrolls under the toolbar, so Delete stays in reach of a row selected far down. The half row shows there is more.
const MAX_VISIBLE_ROWS = 10.5;
// The header and toolbar around the list; the dialog stops at 85% of the window, and past that the toolbar would scroll away too.
const DIALOG_CHROME = 120;

function shareTime(iso: string, now = new Date()) {
  const date = new Date(iso), pad = (value: number) => String(value).padStart(2, '0');
  if (locale() === 'en') return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Checkbox({ colors, state, hovered }: { colors: Colors; state: 'on' | 'off' | 'some'; hovered: boolean }) {
  const marked = state !== 'off';
  return <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center',
    borderColor: marked ? colors.accent : hovered ? colors.foreground : colors.foregroundMuted, backgroundColor: marked ? colors.accent : 'transparent' }}>
    {marked && <Icon name={state === 'on' ? 'Check' : 'Minus'} size={12} color={colors.accentForeground} />}
  </View>;
}

/** Delete is only outlined, on the bare dialog surface where its red stays readable; the fill is kept for the click that actually deletes. */
function Action({ colors, height, label, tone = 'neutral', onPress }: { colors: Colors; height: number; label: string; tone?: 'neutral' | 'danger' | 'confirm'; onPress(): void }) {
  const ink = tone === 'confirm' ? colors.accentForeground : tone === 'danger' ? colors.statusDanger : colors.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={{ height, paddingHorizontal: 12, borderRadius: 6, alignItems: 'center', justifyContent: 'center', ...(tone === 'danger' ? { borderWidth: 1, borderColor: colors.border } : { backgroundColor: tone === 'confirm' ? colors.statusDanger : colors.surface2 }) }}>
    <Text numberOfLines={1} style={{ color: ink, fontSize: 13, lineHeight: 16 }}>{label}</Text>
  </Pressable>;
}

function ShareRow({ row, colors, compact, height, actionHeight, checked, disabled, onToggle }: { row: Row; colors: Colors; compact: boolean; height: number; actionHeight: number; checked: boolean; disabled: boolean; onToggle(): void }) {
  const [hovered, setHovered] = useState(false), [linkHovered, setLinkHovered] = useState(false);
  const time = shareTime(row.createdAt);
  const title = <Text numberOfLines={1} style={{ flex: compact ? 0 : 1, minWidth: 0, color: colors.foreground, fontSize: 14, lineHeight: 18 }}>{row.title}</Text>;
  const date = <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] }}>{time}</Text>;
  return <View style={{ minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: INSET, paddingRight: INSET - (actionHeight - 14) / 2 }}>
    <Pressable accessibilityRole="checkbox" accessibilityLabel={t(`选择 ${row.title} ${time}`, `Select ${row.title} ${time}`)} accessibilityState={{ checked, disabled }} disabled={disabled}
      onPress={onToggle} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={{ flex: 1, minWidth: 0, minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Checkbox colors={colors} state={checked ? 'on' : 'off'} hovered={hovered && !disabled} />
      {/* A phone cannot spare the width: the date beside the title left it about 20 characters. */}
      {compact ? <View style={{ flex: 1, minWidth: 0 }}>{title}{date}</View> : <>{title}{date}</>}
    </Pressable>
    <Pressable accessibilityRole="link" accessibilityLabel={t(`打开 ${row.title} ${time}`, `Open ${row.title} ${time}`)} onPress={() => void openExternalUrl(row.url).catch(() => {})}
      onHoverIn={() => setLinkHovered(true)} onHoverOut={() => setLinkHovered(false)} style={{ width: actionHeight, height: actionHeight, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="ExternalLink" size={14} color={linkHovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  </View>;
}

/** The final layout with flat bars for its values, so the rows land without moving anything. */
function LoadingRows({ colors, height }: { colors: Colors; height: number }) {
  const bar = (width: number | `${number}%`, barHeight = 8) => <View style={{ width, height: barHeight, borderRadius: 4, backgroundColor: colors.surface2 }} />;
  return <View accessibilityLabel={t('正在读取…', 'Loading…')}>
    <View style={{ minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: INSET, borderBottomWidth: 1, borderColor: colors.border }}>
      {bar(16, 16)}{bar(56)}
    </View>
    {[62, 44, 54].map(width => <View key={width} style={{ minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: INSET }}>
      {bar(16, 16)}
      <View style={{ flex: 1 }}>{bar(`${width}%`)}</View>
      {bar(72)}
    </View>)}
  </View>;
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
  const rowHeight = compact ? 56 : 44, actionHeight = compact ? 44 : 30;

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

  const message = { paddingHorizontal: INSET, paddingVertical: 8, fontSize: 13, lineHeight: 18 };
  const count = selected.size, total = rows?.length ?? 0;
  const [hovered, setHovered] = useState(false), { height: windowHeight } = useWindowDimensions();
  return <View style={compact ? { flex: 1, minHeight: 0 } : { paddingBottom: 8 }}>
    {error && <View style={{ paddingVertical: 8 }}>
      <Text accessibilityRole="alert" style={{ ...message, color: colors.statusDanger }}>{error}</Text>
      {rows === null && <View style={{ paddingHorizontal: INSET, alignItems: 'flex-start' }}>
        <Action colors={colors} height={actionHeight} label={t('重试', 'Retry')} onPress={() => setLoadId(id => id + 1)} />
      </View>}
    </View>}
    {rows === null ? !error && <LoadingRows colors={colors} height={rowHeight} />
      : rows.length === 0 ? <Text style={{ ...message, paddingVertical: 16, color: colors.foregroundMuted }}>{t('没有分享链接', 'No share links')}</Text>
      : <>
        <View style={{ minHeight: rowHeight, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: INSET, paddingVertical: 4, borderBottomWidth: 1, borderColor: colors.border }}>
          {confirming ? <>
            <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{t(`删除 ${count} 个分享链接？无法恢复，链接约 5 分钟后失效。`, `Delete ${count} share link${count === 1 ? "" : "s"}? This cannot be undone. Links expire in about 5 minutes.`)}</Text>
            <Action colors={colors} height={actionHeight} label={t('取消', 'Cancel')} onPress={() => setConfirming(false)} />
            <Action colors={colors} height={actionHeight} label={t('确认删除', 'Confirm deletion')} tone="confirm" onPress={() => void deleteSelected()} />
          </> : <>
            <Pressable accessibilityRole="checkbox" accessibilityLabel={t('全选', 'Select all')} accessibilityState={{ checked: count === total ? true : count > 0 ? 'mixed' : false, disabled: deleting }} disabled={deleting}
              onPress={() => setSelected(count === total ? new Set() : new Set((rows ?? []).map(row => row.gistId)))} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
              style={{ flex: 1, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Checkbox colors={colors} state={count === total ? 'on' : count > 0 ? 'some' : 'off'} hovered={hovered && !deleting} />
              <Text numberOfLines={1} style={{ color: count > 0 ? colors.foreground : colors.foregroundMuted, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] }}>
                {count > 0 ? t(`已选 ${count}/${total}`, `${count} of ${total} selected`) : t(`${total} 个链接`, `${total} link${total === 1 ? '' : 's'}`)}
              </Text>
            </Pressable>
            {deleting ? <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] }}>{t(`正在删除 ${progress.done + 1}/${progress.total}`, `Deleting ${progress.done + 1}/${progress.total}`)}</Text>
              : count > 0 && <Action colors={colors} height={actionHeight} label={t(`删除 ${count} 个`, `Delete ${count}`)} tone="danger" onPress={() => setConfirming(true)} />}
          </>}
        </View>
        <ScrollView style={compact ? { flex: 1, minHeight: 0 } : { maxHeight: Math.min(MAX_VISIBLE_ROWS * rowHeight, windowHeight * 0.85 - DIALOG_CHROME) }}>
          {rows.map(row => <ShareRow key={row.gistId} row={row} colors={colors} compact={compact} height={rowHeight} actionHeight={actionHeight} checked={selected.has(row.gistId)} disabled={deleting || confirming} onToggle={() => toggle(row.gistId)} />)}
        </ScrollView>
      </>}
  </View>;
}

export function ManageSharesModal({ open, onOpenChange, colors, compact, onChanged }: { open: boolean; onOpenChange(open: boolean): void; colors: Colors; compact: boolean; onChanged(): void }) {
  return <Modal title={t('管理分享链接', 'Manage share links')} open={open} onOpenChange={onOpenChange}>
    {/* A bounded body fixes the dialog at 85% of the window, so only the compact sheet, which fills anyway, asks for one. */}
    <Modal.Content scrollable={!compact} contentContainerStyle={{ padding: 0, gap: 0 }}>
      <ManageSharesBody open={open} colors={colors} compact={compact} onChanged={onChanged} />
    </Modal.Content>
  </Modal>;
}
