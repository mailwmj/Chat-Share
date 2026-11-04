import { locale, setLocale, t, translateError } from './i18n';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, Text, View } from 'react-native';
import { defineTranslations, usePaseo, useRpc, useTranslation, type PluginButtonContentProps, type PluginClientContext, type PluginScreenProps } from '@getpaseo/plugin/client';
import { copyText, Icon, ScrollView, useToast } from '@getpaseo/plugin/client/ui';
import { listShares, shareAgent, type SharedSnapshot } from '../shared/plugin';
import { observeDirectory } from './directory';
import { ManageSharesModal } from './manage-shares';
import { providerIcon } from './provider-icons';
import { menuPosition, visibleRange } from './web';

type AgentDirectory = Awaited<ReturnType<PluginClientContext['paseo']['agents']['list']>>;
type PaseoAgent = AgentDirectory['entries'][number]['agent'];

// Paseo gives navigation to screens and panels but not yet to button popovers; rows only become openable once a host passes it.
type SharePopoverProps = PluginButtonContentProps & Pick<PluginScreenProps, 'navigation'>;

type Colors = PluginButtonContentProps['theme']['colors'];
type Phase = 'checking' | 'share' | 'pending' | 'copied' | 'copy';

const settle = Easing.bezier(0.25, 0.8, 0.25, 1);
const nativeDriver = Platform.OS !== 'web';
const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;
const COPIED_MS = 1600;
// The host caps a popover surface at 420 x 440, with 12px of padding this panel pulls back by 8px.
const PANEL_WIDTH = 404, LIST_MAX_HEIGHT = 416;
const ACTION_GAP = 0, SWEEP_WIDTH = 36;
// Sized for the longest idle label (复制链接 / Copy link); busy states show only an icon.
const actionWidth = () => locale() === 'zh' ? 70 : 76;

// Read only for its locale: the hook re-renders the popover when the Paseo app language changes.
const languageProbe = defineTranslations({ resources: { en: { language: 'language' } } });

const shareText = (shared: SharedSnapshot) => shared.locked && shared.password ? `${shared.url}\n${t('密码：', 'Password: ')}${shared.password}` : shared.url;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (live) setReduced(value); }, () => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { live = false; subscription.remove(); };
  }, []);
  return reduced;
}

function useTween(target: number, duration: number, still: boolean, { from = target, delay = 0, easing = settle } = {}) {
  const value = useRef(new Animated.Value(still ? target : from)).current;
  useEffect(() => {
    const run = Animated.timing(value, { toValue: target, duration: still ? 0 : duration, delay: still ? 0 : delay, easing, useNativeDriver: nativeDriver });
    run.start();
    return () => run.stop();
  }, [target, still]);
  return value;
}

function useLoop(duration: number, still: boolean, easing: (value: number) => number) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (still) return;
    const run = Animated.loop(Animated.timing(value, { toValue: 1, duration, easing, useNativeDriver: nativeDriver }));
    run.start();
    return () => run.stop();
  }, [still]);
  return value;
}

function usePresence(open: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);
  return open || mounted;
}

function FadeIn({ still, delay = 0, children }: { still: boolean; delay?: number; children: ReactNode }) {
  const opacity = useTween(1, 160, still, { from: 0, delay });
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

function FaceMotion({ shown, still, children }: { shown: boolean; still: boolean; children: ReactNode }) {
  const opacity = useTween(shown ? 1 : 0, shown ? 150 : 80, still, { from: 0, delay: shown ? 50 : 0 });
  const rise = useTween(shown ? 0 : -4, shown ? 180 : 80, still, { from: 4 });
  return <Animated.View pointerEvents="none" aria-hidden={!shown} style={{ ...fill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8, zIndex: 1, opacity, transform: [{ translateY: rise }] }}>{children}</Animated.View>;
}

/** One state of the action. The outgoing face lifts away while the next rises into the same fixed box. */
function Face({ shown, still, children }: { shown: boolean; still: boolean; children: ReactNode }) {
  return usePresence(shown, still ? 0 : 120) ? <FaceMotion shown={shown} still={still}>{children}</FaceMotion> : null;
}

function Label({ colors, children }: { colors: Colors; children: string }) {
  return <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, lineHeight: 16 }}>{children}</Text>;
}

function Spinner({ colors, still }: { colors: Colors; still: boolean }) {
  const turn = useLoop(800, still, Easing.linear);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View style={{ width: 14, height: 14, transform: [{ rotate }] }}><Icon name="LoaderCircle" size={14} color={colors.foregroundMuted} /></Animated.View>;
}

/** A band crossing the action while GitHub creates the link. */
function Sweep({ colors, still }: { colors: Colors; still: boolean }) {
  const travel = useLoop(1100, still, settle);
  const translateX = travel.interpolate({ inputRange: [0, 1], outputRange: [-SWEEP_WIDTH, actionWidth()] });
  if (still) return null;
  return <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: SWEEP_WIDTH, backgroundColor: colors.foreground, opacity: 0.08, zIndex: 0, transform: [{ translateX }] }} />;
}

function CheckMark({ colors, still }: { colors: Colors; still: boolean }) {
  const scale = useTween(1, 220, still, { from: 0.5, easing: Easing.out(Easing.back(2)) });
  return <Animated.View style={{ transform: [{ scale }] }}><Icon name="Check" size={14} color={colors.statusSuccess} /></Animated.View>;
}

function ShareAction({ colors, height, still: reduced, phase, locked, title, onPress }: { colors: Colors; height: number; still: boolean; phase: Phase; locked: boolean; title: string; onPress(): void }) {
  const [hovered, setHovered] = useState(false), [down, setDown] = useState(false);
  // The opening state appears at once; only later state changes animate.
  const [entered, setEntered] = useState(false);
  useEffect(() => setEntered(true), []);
  const still = reduced || !entered;
  const disabled = phase === 'checking' || phase === 'pending';
  useEffect(() => { if (disabled) { setHovered(false); setDown(false); } }, [disabled]);
  // A row that needs sharing stays an outline; a filled action means a current link is ready.
  const filled = phase === 'pending' || phase === 'copied' || phase === 'copy' || (phase === 'share' && (hovered || down));
  const wash = useTween(filled ? 1 : 0, filled ? 100 : 160, still);
  const lift = useTween(hovered && phase !== 'share' ? 0.08 : 0, hovered ? 80 : 160, still);
  const scale = useTween(down ? 0.97 : 1, down ? 60 : 140, still);
  const sweep = usePresence(phase === 'pending', still ? 0 : 120);
  const label = phase === 'checking' ? t(`正在检查 ${title} 的分享状态`, `Checking share status for ${title}`) : phase === 'pending' ? t(`正在创建 ${title} 的分享链接`, `Creating share link for ${title}`)
    : phase === 'copied' || phase === 'copy' ? (locked ? t(`复制 ${title} 的链接和密码`, `Copy link and password for ${title}`) : t(`复制 ${title} 的链接`, `Copy link for ${title}`)) : locked ? t(`加密分享 ${title}`, `Share ${title} encrypted`) : t(`分享 ${title}`, `Share ${title}`);
  return <Animated.View style={{ transform: [{ scale }] }}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy: phase === 'pending' }} disabled={disabled} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onPressIn={() => setDown(true)} onPressOut={() => setDown(false)}
      style={{ width: actionWidth(), height, overflow: 'hidden' }}>
      <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.surface2, opacity: wash, zIndex: 0 }} />
      <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.foreground, opacity: lift, zIndex: 0 }} />
      {sweep && <Sweep colors={colors} still={still} />}
      <Face shown={phase === 'checking'} still={still}><Label colors={colors}>{t('检查中', 'Checking')}</Label></Face>
      <Face shown={phase === 'share' && !locked} still={still}><Label colors={colors}>{t('分享', 'Share')}</Label></Face>
      <Face shown={phase === 'share' && locked} still={still}><Label colors={colors}>{t('加密分享', 'Encrypt')}</Label></Face>
      <Face shown={phase === 'pending'} still={still}><Spinner colors={colors} still={still} /></Face>
      <Face shown={phase === 'copied'} still={still}><CheckMark colors={colors} still={still} /></Face>
      <Face shown={phase === 'copy'} still={still}><Label colors={colors}>{t('复制链接', 'Copy link')}</Label></Face>
    </Pressable>
  </Animated.View>;
}

/** The last check of each link, shown on reopen while a new check runs. */
type Verdicts = WeakMap<SharedSnapshot, boolean>;

/** Compare canonical content, rather than updatedAt (which also changes for titles and settings). */
function useSnapshotFreshness(agentId: string, shared: SharedSnapshot | undefined, verdicts: Verdicts) {
  const paseo = usePaseo();
  const [result, setResult] = useState<{ shared: SharedSnapshot; fresh: boolean }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!shared) return;
    const version = shared.version, timeline = paseo.agents.ref(agentId).timeline;
    let live = true, changed = false;
    const decide = (fresh: boolean) => { verdicts.set(shared, fresh); if (live) setResult({ shared, fresh }); };
    const stale = () => { changed = true; decide(false); };
    const unavailable = () => { verdicts.delete(shared); if (live) { setResult(undefined); setFailed(true); } };
    const refresh = async () => {
      try {
        const page = await timeline.refetch({ direction: 'tail', limit: 1, projection: 'projected' });
        if (!live || changed) return;
        if (page.error || page.reset || page.gap || page.staleCursor) throw new Error('Unavailable timeline');
        setFailed(false);
        decide(page.epoch === version.epoch && page.window.maxSeq === version.maxSeq);
      } catch { unavailable(); }
    };
    const stop = timeline.subscribe(message => {
      if (!live) return;
      if (message.event.type === 'replacement') stale();
      else if (message.event.type === 'subscription_restored') { if (!changed) { verdicts.delete(shared); setResult(undefined); void refresh(); } }
      else if (message.event.type === 'error') unavailable();
      else if ('seq' in message && message.seq !== undefined
        && (message.epoch !== version.epoch || message.seq > version.maxSeq)) stale();
    });
    void stop.ready.then(refresh, unavailable);
    return () => { live = false; stop(); };
  }, [paseo, agentId, shared]);
  return { fresh: result?.shared === shared ? result?.fresh : shared && verdicts.get(shared), failed };
}

function MenuToggle({ colors, size, still, disabled, open, title, onPress }: { colors: Colors; size: number; still: boolean; disabled: boolean; open: boolean; title: string; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => { if (disabled) setHovered(false); }, [disabled]);
  const wash = useTween(hovered || open ? 1 : 0, hovered ? 80 : 160, still);
  const opacity = useTween(disabled ? 0.4 : 1, 150, still);
  return <Animated.View style={{ opacity }}>
    <Pressable accessibilityRole="button" accessibilityLabel={t(`更多分享方式 ${title}`, `More sharing options for ${title}`)} accessibilityState={{ disabled, expanded: open }} disabled={disabled} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={{ width: size, height: size, borderLeftWidth: 1, borderColor: colors.border, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.surface2, opacity: wash, zIndex: 0 }} />
      <View pointerEvents="none" style={{ position: 'relative', zIndex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="Ellipsis" size={16} color={hovered || open ? colors.foreground : colors.foregroundMuted} />
      </View>
    </Pressable>
  </Animated.View>;
}

function MenuItem({ colors, height, still, label, title, onPress }: { colors: Colors; height: number; still: boolean; label: string; title?: string; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  const wash = useTween(hovered ? 1 : 0, hovered ? 80 : 160, still);
  return <Pressable accessibilityRole="button" accessibilityLabel={title ? `${label} ${title}` : label} onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={{ minWidth: actionWidth() + ACTION_GAP + height, height, borderRadius: 4, overflow: 'hidden', justifyContent: 'center', paddingHorizontal: 10 }}>
    <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.surface2, opacity: wash, zIndex: 0 }} />
    <View pointerEvents="none" style={{ position: 'relative', zIndex: 1 }}>
      <Label colors={colors}>{label}</Label>
    </View>
  </Pressable>;
}

type MenuOption = { label: string; locked: boolean };

function AgentRow({ agent, colors, height, actionHeight, still, phase, shared, verdicts, error, copyFailed, menuOpen, onOpen, onMenu, onShare, onCopy }: {
  agent: PaseoAgent; colors: Colors; height: number; actionHeight: number; still: boolean; phase: Phase; shared?: SharedSnapshot; verdicts: Verdicts; error?: string; copyFailed: boolean; menuOpen: boolean; onOpen?(): void; onMenu(y: number, title: string, options: MenuOption[]): void; onShare(locked: boolean): void; onCopy(shared: SharedSnapshot): void;
}) {
  const rowY = useRef(0);
  const title = agent.title || t('未命名会话', 'Untitled conversation');
  // A locked link is useless without its password, so it can only be replaced and needs no freshness check.
  const copyable = shared && (!shared.locked || shared.password) ? shared : undefined;
  const { fresh, failed } = useSnapshotFreshness(agent.id, copyable, verdicts);
  let currentPhase = phase;
  if (shared && phase !== 'pending') currentPhase = !copyable || fresh === false || (failed && fresh !== true) ? 'share' : fresh === true ? phase : 'checking';
  // Keep the mode this conversation was shared in: one click must never turn an encrypted share into plaintext.
  const locked = !!shared?.locked, copying = currentPhase === 'copy' || currentPhase === 'copied';
  const menu = copying ? [{ label: t('重新分享', 'Share again'), locked: false }, { label: t('重新加密分享', 'Share encrypted again'), locked: true }]
    : [locked ? { label: t('分享', 'Share'), locked: false } : { label: t('加密分享', 'Share encrypted'), locked: true }];
  const busy = currentPhase === 'checking' || currentPhase === 'pending';
  const textInset = { paddingLeft: 32, paddingRight: 8, paddingBottom: 8, fontSize: 13, lineHeight: 18 };
  const identityStyle = { flex: 1, minWidth: 0, minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 8 } as const;
  const identity = <>
    <View accessibilityRole="image" accessibilityLabel={agent.provider} style={{ width: 16, height: 16 }}><Icon {...providerIcon(agent.provider)} size={16} color={colors.foregroundMuted} /></View>
    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 14, lineHeight: 18 }}>{title}</Text>
  </>;
  return <View onLayout={event => { rowY.current = event.nativeEvent.layout.y; }}>
    <View style={{ minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}>
      {onOpen ? <Pressable accessibilityRole="button" accessibilityLabel={t(`打开 ${title}`, `Open ${title}`)} onPress={onOpen} style={identityStyle}>{identity}</Pressable>
        : <View style={identityStyle}>{identity}</View>}
      <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: 'hidden' }}>
        <ShareAction colors={colors} height={actionHeight} still={still} phase={currentPhase} locked={locked} title={title} onPress={() => { if (copying && shared) onCopy(shared); else onShare(locked); }} />
        <MenuToggle colors={colors} size={actionHeight} still={still} disabled={busy} open={menuOpen && !busy} title={title} onPress={() => onMenu(rowY.current, title, menu)} />
      </View>
    </View>
    {!!error && <>
      <Text accessibilityRole="alert" style={{ ...textInset, color: colors.statusDanger }}>{error}</Text>
    </>}
    {failed && !error && <>
      <Text style={{ ...textInset, color: colors.foregroundMuted }}>{t('无法确认快照是否最新，请重新生成分享。', 'Could not verify that the snapshot is current. Create a new share.')}</Text>
    </>}
    {copyFailed && fresh === true && <>
      <Text selectable style={{ ...textInset, color: colors.foreground }}>{shared && shareText(shared)}</Text>
    </>}
  </View>;
}

function SkeletonRows({ colors, height, actionHeight, still }: { colors: Colors; height: number; actionHeight: number; still: boolean }) {
  return <FadeIn still={still} delay={120}>
    <View accessibilityLabel={t('正在读取会话…', 'Loading conversations…')} style={{ gap: 2, paddingVertical: 4 }}>
      {[62, 44, 54].map(width => <View key={width} style={{ height, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}>
        <View style={{ width: 16, height: 16, borderRadius: 4, backgroundColor: colors.surface2 }} />
        <View style={{ flex: 1 }}><View style={{ width: `${width}%`, height: 8, borderRadius: 4, backgroundColor: colors.surface2 }} /></View>
        <View style={{ width: actionWidth() + ACTION_GAP + actionHeight, height: actionHeight, borderRadius: 6, backgroundColor: colors.surface2, opacity: 0.5 }} />
      </View>)}
    </View>
  </FadeIn>;
}

interface ShareState {
  /** False until the first lookup settles; offering 分享 before then would create duplicate links. */
  checked: boolean;
  links: Readonly<Record<string, SharedSnapshot>>;
  lookupError?: string;
  pending: ReadonlySet<string>;
  errors: Readonly<Record<string, string>>;
}

function createShareStore() {
  let state: ShareState = { checked: false, links: {}, pending: new Set(), errors: {} };
  // Links made this session win over a lookup that may have started before GitHub listed them.
  let created: Record<string, SharedSnapshot> = {};
  let lookupId = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<ShareState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  const settled = (agentId: string) => {
    const pending = new Set(state.pending);
    pending.delete(agentId);
    return pending;
  };
  return {
    get: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    lookup() { created = {}; set({ lookupError: undefined }); return ++lookupId; },
    checked(id: number, links: Record<string, SharedSnapshot>) {
      if (id !== lookupId) return;
      // An unchanged link keeps its identity, so a background lookup does not restart its row's check.
      const merged = Object.entries({ ...links, ...created }).map(([agentId, link]) => {
        const known = state.links[agentId];
        return [agentId, known?.url === link.url && known.version.epoch === link.version.epoch && known.version.maxSeq === link.version.maxSeq ? known : link];
      });
      set({ checked: true, lookupError: undefined, links: Object.fromEntries(merged) });
    },
    lookupFailed(id: number, message: string) { if (id === lookupId) set({ lookupError: message }); },
    /** False when this agent is already uploading. */
    begin(agentId: string) {
      if (state.pending.has(agentId)) return false;
      const { [agentId]: _cleared, ...errors } = state.errors;
      set({ pending: new Set(state.pending).add(agentId), errors });
      return true;
    },
    succeed(agentId: string, shared: SharedSnapshot) {
      created[agentId] = shared;
      set({ pending: settled(agentId), links: { ...state.links, [agentId]: shared } });
    },
    fail(agentId: string, message: string) { set({ pending: settled(agentId), errors: { ...state.errors, [agentId]: message } }); },
  };
}

const AGENT_FILTER = { includeArchived: false, includeBackground: true };
// Plugins cannot read the host's tab layout; creation order is the closest stable match.
const tabOrder = (entries: PaseoAgent[]) => entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

export async function listAllAgents(paseo: PluginClientContext['paseo']) {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: AGENT_FILTER, page: { limit: 200, cursor } });
    agents.push(...page.entries.map(({ agent }) => agent));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}

type LookupLinks = () => Promise<{ links: Record<string, SharedSnapshot> } | { error: string }>;

/** An installation keeps uploads, known links, rows and checks across popover closes and workspace switches. */
export function createSharePopover(preload?: LookupLinks, preloadAgents?: () => Promise<PaseoAgent[]>) {
  const store = createShareStore();
  const agentsByWorkspace = new Map<string, PaseoAgent[]>();
  const verdicts: Verdicts = new WeakMap();
  // One lookup at a time: opening during another must not restart a slow GitHub listing.
  let lookingUp: Promise<void> | undefined;
  const refreshLinks = (lookup: LookupLinks) => lookingUp ??= (async () => {
    const id = store.lookup();
    try {
      const result = await lookup();
      if ('error' in result) store.lookupFailed(id, translateError(result.error));
      else store.checked(id, result.links);
    } catch { store.lookupFailed(id, t('读取分享链接失败，请稍后重试。', 'Could not load share links. Please try again.')); }
  })().finally(() => { lookingUp = undefined; });
  if (preload) void refreshLinks(preload);
  // A listing already under way may have read a Gist that has since been deleted, so look again once it ends.
  const refreshAfterDelete = (lookup: LookupLinks) => void Promise.resolve(lookingUp).then(() => refreshLinks(lookup));
  // Known rows make the first open full height at once. A failed preload just means loading on open.
  void preloadAgents?.().then(agents => {
    const grouped = new Map<string, PaseoAgent[]>();
    for (const agent of agents) if (agent.workspaceId && !agent.archivedAt) grouped.set(agent.workspaceId, [...grouped.get(agent.workspaceId) ?? [], agent]);
    for (const [workspaceId, entries] of grouped) if (!agentsByWorkspace.has(workspaceId)) agentsByWorkspace.set(workspaceId, tabOrder(entries));
  }, () => {});
  return function SharePopover({ workspaceId, theme, layout, navigation, close }: SharePopoverProps) {
    setLocale(useTranslation(languageProbe).locale);
    const paseo = usePaseo(), rpc = useRpc(shareAgent), lookup = useRpc(listShares), toast = useToast(), colors = theme.colors, still = useReducedMotion();
    const shares = useSyncExternalStore(store.subscribe, store.get);
    const [agents, setAgents] = useState<PaseoAgent[] | null>(() => agentsByWorkspace.get(workspaceId) ?? null);
    const reopened = useRef(agents !== null).current;
    const [listFailed, setListFailed] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [copyFailed, setCopyFailed] = useState<string | null>(null);
    const [menu, setMenu] = useState<{ agentId: string; title: string; options: MenuOption[]; y: number } | null>(null);
    const panelRef = useRef<View>(null);
    const [bounds, setBounds] = useState<{ top: number; bottom: number }>();
    const [listY, setListY] = useState(0), [panelHeight, setPanelHeight] = useState(0);
    const scrollY = useRef(0);
    const [managing, setManaging] = useState(false);
    const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const open = useRef(false);
    useEffect(() => {
      if (!menu || Platform.OS !== 'web') return;
      const doc = (globalThis as unknown as { document: { addEventListener(type: string, listener: (event: { key: string; stopPropagation(): void }) => void): void; removeEventListener(type: string, listener: (event: { key: string; stopPropagation(): void }) => void): void } }).document;
      const onKeyDown = (event: { key: string; stopPropagation(): void }) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); } };
      doc.addEventListener('keydown', onKeyDown);
      return () => doc.removeEventListener('keydown', onKeyDown);
    }, [menu]);
    const refresh = () => void refreshLinks(() => lookup({}));
    useEffect(() => {
      open.current = true;
      refresh();
      return () => { open.current = false; clearTimeout(copiedTimer.current); };
    }, []);
    useEffect(() => { if (agents) agentsByWorkspace.set(workspaceId, agents); }, [agents, workspaceId]);
    async function copy(agentId: string, shared: SharedSnapshot, notice = '') {
      clearTimeout(copiedTimer.current);
      try {
        await copyText(shareText(shared));
        toast.show(`${shared.locked ? t('链接和密码已复制', 'Link and password copied') : t('链接已复制', 'Link copied')}${notice}`, { variant: 'success' });
        if (!open.current) return;
        setCopyFailed(null);
        setCopied(agentId);
        copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
      } catch { if (open.current) { setCopied(null); setCopyFailed(agentId); toast.error(t('复制失败，请复制下方链接。', 'Copy failed. Copy the link below.')); } }
    }
    async function share(agentId: string, locked: boolean) {
      const previous = store.get().links[agentId];
      // Sharing again never touches the earlier Gist, so encrypting does not protect the old link.
      const notice = locked && previous && !previous.locked ? t('。旧的明文链接仍可打开，需到 GitHub 删除。', '. The old unencrypted link still works; delete it on GitHub.') : '';
      if (!store.begin(agentId)) return;
      try {
        const result = await rpc(locked ? { agentId, locked } : { agentId }).catch(() => { throw new Error(t('分享失败，请稍后重试。', 'Sharing failed. Please try again.')); });
        if ('error' in result) throw new Error(translateError(result.error));
        store.succeed(agentId, result);
        if (open.current) setCopyFailed(current => current === agentId ? null : current);
        // A closed popover must not overwrite whatever the user has copied since.
        if (open.current) await copy(agentId, result, notice);
        else toast.show(t(`分享链接已创建${notice}`, `Share link created${notice}`), { variant: 'success' });
      } catch (error) {
        const message = (error as Error).message;
        store.fail(agentId, message);
        toast.error(message);
      }
    }
    useEffect(() => {
      return observeDirectory(
        (cursor, subscribe) => paseo.agents.list({ filter: AGENT_FILTER, page: { limit: 200, cursor }, ...(subscribe ? { subscribe: {} } : {}) }),
        {
            snapshot: entries => {
              setAgents(tabOrder(entries.map(({ agent }) => agent).filter(agent => agent.workspaceId === workspaceId && !agent.archivedAt)));
              setListFailed(false);
            },
            update: message => {
              if (message.type !== 'agent_update') return;
              const update = message.payload;
              setAgents(current => {
                const id = update.kind === 'upsert' ? update.agent.id : update.agentId;
                const remaining = (current ?? []).filter(agent => agent.id !== id);
                if (update.kind === 'upsert' && update.agent.workspaceId === workspaceId && !update.agent.archivedAt) remaining.push(update.agent);
                return tabOrder(remaining);
              });
            },
            error: () => setListFailed(true),
        });
    }, [paseo, workspaceId]);
    const rowHeight = layout.compact ? 56 : 40, actionHeight = layout.compact ? 44 : 28;
    const menuHeight = menu ? (menu.options.length + 1) * actionHeight + 9 : 0;
    const menuBelow = menu ? listY + menu.y - scrollY.current + (rowHeight + actionHeight) / 2 + 4 : 0;
    const menuAbove = menu ? listY + menu.y - scrollY.current + (rowHeight - actionHeight) / 2 - menuHeight - 4 : 0;
    const visibleTop = Math.max(0, bounds?.top ?? 0), visibleBottom = Math.min(panelHeight, bounds?.bottom ?? panelHeight);
    const menuTop = menuPosition(menuBelow, menuAbove, menuHeight, visibleTop, visibleBottom);
    const message = { paddingHorizontal: 8, paddingVertical: 8, fontSize: 13, lineHeight: 18 };
    const phaseOf = (agentId: string): Phase => shares.pending.has(agentId) ? 'pending'
      : copied === agentId ? 'copied'
      : shares.links[agentId] !== undefined ? 'copy'
      : shares.checked ? 'share' : 'checking';
    return <View ref={panelRef} onLayout={event => setPanelHeight(event.nativeEvent.layout.height)} style={{ margin: -8, ...(layout.compact ? {} : { width: PANEL_WIDTH }), ...(menu ? { minHeight: rowHeight + menuHeight + 8 } : {}) }}>
      {shares.lookupError && <View style={{ padding: 8, gap: 4 }}>
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13, lineHeight: 18 }}>{shares.lookupError}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('重试读取分享链接', 'Retry loading share links')} onPress={refresh} style={{ minHeight: actionHeight, justifyContent: 'center' }}>
          <Text style={{ color: colors.foreground, fontSize: 13 }}>{t('重试', 'Retry')}</Text>
        </Pressable>
      </View>}
      {/* In normal flow, never animating height: the host's scroll viewport follows content height a frame late, and each overflow shows a scrollbar that widens the surface. */}
      {listFailed ? <Text style={{ ...message, color: colors.statusDanger }}>{t('读取会话失败，请重新打开。', 'Could not load conversations. Reopen this menu.')}</Text>
          : agents === null ? <SkeletonRows colors={colors} height={rowHeight} actionHeight={actionHeight} still={still} />
          : agents.length === 0 ? <Text style={{ ...message, color: colors.foregroundMuted }}>{t('暂无会话', 'No conversations')}</Text>
          : <View onLayout={event => setListY(event.nativeEvent.layout.y)}><FadeIn still={still || reopened}><ScrollView style={{ maxHeight: LIST_MAX_HEIGHT }} contentContainerStyle={{ gap: 2, paddingVertical: 4 }} bounces={false} onScroll={event => { scrollY.current = event.nativeEvent.contentOffset.y; setMenu(null); }} scrollEventThrottle={16}>{agents.map(agent =>
            <AgentRow key={agent.id} agent={agent} colors={colors} height={rowHeight} actionHeight={actionHeight} still={still} phase={phaseOf(agent.id)}
              shared={shares.links[agent.id]} verdicts={verdicts} error={shares.errors[agent.id]} copyFailed={copyFailed === agent.id} menuOpen={menu?.agentId === agent.id}
              onOpen={navigation && (() => { navigation.openAgent({ agentId: agent.id }); close(); })}
              onMenu={(y, title, options) => { setBounds(visibleRange(panelRef.current)); setMenu(current => current?.agentId === agent.id ? null : { agentId: agent.id, y, title, options }); }}
              onShare={locked => { setMenu(null); void share(agent.id, locked); }}
              onCopy={shared => { setMenu(null); void copy(agent.id, shared); }} />)}</ScrollView></FadeIn></View>}
      {(listFailed || agents?.length === 0) && <Pressable accessibilityRole="button" accessibilityLabel={t('管理分享链接', 'Manage share links')} onPress={() => setManaging(true)}
        style={{ minHeight: actionHeight, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 8 }}>
        <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 16 }}>{t('管理分享链接', 'Manage share links')}</Text>
      </Pressable>}
      <ManageSharesModal open={managing} onOpenChange={setManaging} colors={colors} compact={layout.compact} onChanged={() => refreshAfterDelete(() => lookup({}))} />
      {menu && <>
        <Pressable accessibilityRole="button" accessibilityLabel={t('关闭分享菜单', 'Close share menu')} onPress={() => setMenu(null)} style={fill} />
        <View style={{ position: 'absolute', top: menuTop, right: 8, padding: 4, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8 }}>
          {menu.options.map(item => <MenuItem key={item.label} colors={colors} height={actionHeight} still={still} label={item.label} title={menu.title} onPress={() => { const id = menu.agentId; setMenu(null); void share(id, item.locked); }} />)}
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <MenuItem colors={colors} height={actionHeight} still={still} label={t('管理分享链接', 'Manage share links')} onPress={() => { setMenu(null); setManaging(true); }} />
        </View>
      </>}
    </View>;
  };
}
