import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, Text, View } from 'react-native';
import { usePaseo, useRpc, type PluginButtonContentProps, type PluginClientContext } from '@getpaseo/plugin/client';
import { copyText, Icon, ScrollView, useToast } from '@getpaseo/plugin/client/ui';
import { listShares, shareAgent, type SharedSnapshot } from '../shared/plugin';
import { observeDirectory } from './directory';
import { providerIcon } from './provider-icons';

type AgentDirectory = Awaited<ReturnType<PluginClientContext['paseo']['agents']['list']>>;
type PaseoAgent = AgentDirectory['entries'][number]['agent'];

type Colors = PluginButtonContentProps['theme']['colors'];
type Phase = 'checking' | 'share' | 'pending' | 'copied' | 'copy';

const settle = Easing.bezier(0.25, 0.8, 0.25, 1);
const nativeDriver = Platform.OS !== 'web';
const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;
const COPIED_MS = 1600;
// The host caps a popover surface at 420 x 440, with 12px of padding this panel pulls back by 8px.
const PANEL_WIDTH = 404, LIST_MAX_HEIGHT = 416;
const ACTION_WIDTH = 88, ACTION_GAP = 2, SWEEP_WIDTH = 36;

const shareText = (shared: SharedSnapshot) => shared.locked && shared.password ? `${shared.url}\n密码：${shared.password}` : shared.url;

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

/** Eases its height to fit the content; the first measure lands without motion so a reopened panel is already whole. */
function Collapse({ open, still, children }: { open: boolean; still: boolean; children: ReactNode }) {
  const height = useRef(new Animated.Value(0)).current;
  const natural = useRef<number | null>(null);
  const kept = useRef(children);
  if (open) kept.current = children;
  const present = usePresence(open, still ? 0 : 160);
  const opacity = useTween(open ? 1 : 0, open ? 140 : 100, still, { delay: open ? 60 : 0 });
  const ease = (toValue: number) => Animated.timing(height, { toValue, duration: still ? 0 : open ? 200 : 160, easing: settle, useNativeDriver: false }).start();
  useEffect(() => { if (natural.current !== null) ease(open ? natural.current : 0); }, [open]);
  return <Animated.View style={{ height, overflow: 'hidden' }}>
    <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, opacity }} onLayout={({ nativeEvent }) => {
      const measured = nativeEvent.layout.height;
      if (natural.current === null) height.setValue(open ? measured : 0);
      else if (open && measured !== natural.current) ease(measured);
      natural.current = measured;
    }}>{present ? kept.current : null}</Animated.View>
  </Animated.View>;
}

function FadeIn({ still, delay = 0, children }: { still: boolean; delay?: number; children: ReactNode }) {
  const opacity = useTween(1, 160, still, { from: 0, delay });
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

function FaceMotion({ shown, still, children }: { shown: boolean; still: boolean; children: ReactNode }) {
  const opacity = useTween(shown ? 1 : 0, shown ? 150 : 80, still, { from: 0, delay: shown ? 50 : 0 });
  const rise = useTween(shown ? 0 : -4, shown ? 180 : 80, still, { from: 4 });
  return <Animated.View pointerEvents="none" aria-hidden={!shown} style={{ ...fill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, opacity, transform: [{ translateY: rise }] }}>{children}</Animated.View>;
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
  const translateX = travel.interpolate({ inputRange: [0, 1], outputRange: [-SWEEP_WIDTH, ACTION_WIDTH] });
  if (still) return null;
  return <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: SWEEP_WIDTH, backgroundColor: colors.foreground, opacity: 0.08, transform: [{ translateX }] }} />;
}

function CheckMark({ colors, still }: { colors: Colors; still: boolean }) {
  const scale = useTween(1, 220, still, { from: 0.5, easing: Easing.out(Easing.back(2)) });
  return <Animated.View style={{ transform: [{ scale }] }}><Icon name="Check" size={14} color={colors.statusSuccess} /></Animated.View>;
}

function ShareAction({ colors, height, still, phase, locked, title, onPress }: { colors: Colors; height: number; still: boolean; phase: Phase; locked: boolean; title: string; onPress(): void }) {
  const [hovered, setHovered] = useState(false), [down, setDown] = useState(false);
  const disabled = phase === 'checking' || phase === 'pending';
  useEffect(() => { if (disabled) { setHovered(false); setDown(false); } }, [disabled]);
  // A row that needs sharing stays an outline; a filled action means a current link is ready.
  const filled = phase === 'pending' || phase === 'copied' || phase === 'copy' || (phase === 'share' && (hovered || down));
  const wash = useTween(filled ? 1 : 0, filled ? 100 : 160, still);
  const lift = useTween(hovered && phase !== 'share' ? 0.08 : 0, hovered ? 80 : 160, still);
  const scale = useTween(down ? 0.97 : 1, down ? 60 : 140, still);
  const sweep = usePresence(phase === 'pending', still ? 0 : 120);
  const label = phase === 'checking' ? `正在检查 ${title} 的分享状态` : phase === 'pending' ? `正在创建 ${title} 的分享链接`
    : phase === 'copied' || phase === 'copy' ? (locked ? `复制 ${title} 的链接和密码` : `复制 ${title} 的链接`) : locked ? `加密分享 ${title}` : `分享 ${title}`;
  return <Animated.View style={{ transform: [{ scale }] }}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy: phase === 'pending' }} disabled={disabled} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onPressIn={() => setDown(true)} onPressOut={() => setDown(false)}
      style={{ width: ACTION_WIDTH, height, borderRadius: 6, overflow: 'hidden', borderWidth: 1, borderColor: filled ? 'transparent' : colors.border }}>
      <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.surface2, opacity: wash }} />
      <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.foreground, opacity: lift }} />
      {sweep && <Sweep colors={colors} still={still} />}
      <Face shown={phase === 'checking'} still={still}><Label colors={colors}>检查中</Label></Face>
      <Face shown={phase === 'share' && !locked} still={still}><Icon name="Share" size={14} color={colors.foregroundMuted} /><Label colors={colors}>分享</Label></Face>
      <Face shown={phase === 'share' && locked} still={still}><Icon name="Lock" size={14} color={colors.foregroundMuted} /><Label colors={colors}>加密分享</Label></Face>
      <Face shown={phase === 'pending'} still={still}><Spinner colors={colors} still={still} /><Label colors={colors}>创建中</Label></Face>
      <Face shown={phase === 'copied'} still={still}><CheckMark colors={colors} still={still} /><Label colors={colors}>已复制</Label></Face>
      <Face shown={phase === 'copy'} still={still}><Icon name={locked ? 'Lock' : 'Copy'} size={14} color={colors.foregroundMuted} /><Label colors={colors}>复制链接</Label></Face>
    </Pressable>
  </Animated.View>;
}

/** Compare canonical content, rather than updatedAt (which also changes for titles and settings). */
function useSnapshotFreshness(agentId: string, shared?: SharedSnapshot) {
  const paseo = usePaseo();
  const [result, setResult] = useState<{ shared: SharedSnapshot; fresh: boolean }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!shared) return;
    const version = shared.version, timeline = paseo.agents.ref(agentId).timeline;
    let live = true, changed = false;
    setFailed(false);
    const stale = () => { changed = true; if (live) setResult({ shared, fresh: false }); };
    const refresh = async () => {
      try {
        const page = await timeline.refetch({ direction: 'tail', limit: 1, projection: 'projected' });
        if (!live || changed) return;
        if (page.error || page.reset || page.gap || page.staleCursor) throw new Error('Unavailable timeline');
        setFailed(false);
        setResult({ shared, fresh: page.epoch === version.epoch && page.window.maxSeq === version.maxSeq });
      } catch { if (live) { setResult(undefined); setFailed(true); } }
    };
    const stop = timeline.subscribe(message => {
      if (!live) return;
      if (message.event.type === 'replacement') stale();
      else if (message.event.type === 'subscription_restored') { if (!changed) { setResult(undefined); void refresh(); } }
      else if (message.event.type === 'error') { setResult(undefined); setFailed(true); }
      else if ('seq' in message && message.seq !== undefined
        && (message.epoch !== version.epoch || message.seq > version.maxSeq)) stale();
    });
    void stop.ready.then(refresh, () => { if (live) setFailed(true); });
    return () => { live = false; stop(); };
  }, [paseo, agentId, shared]);
  return { fresh: result?.shared === shared ? result?.fresh : undefined, failed };
}

function MenuToggle({ colors, size, still, disabled, open, title, onPress }: { colors: Colors; size: number; still: boolean; disabled: boolean; open: boolean; title: string; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => { if (disabled) setHovered(false); }, [disabled]);
  const wash = useTween(hovered || open ? 1 : 0, hovered ? 80 : 160, still);
  const opacity = useTween(disabled ? 0.4 : 1, 150, still);
  const turn = useTween(open ? 1 : 0, 160, still);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  return <Animated.View style={{ opacity }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`更多分享方式 ${title}`} accessibilityState={{ disabled, expanded: open }} disabled={disabled} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={{ width: size, height: size, borderRadius: 6, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.surface2, opacity: wash }} />
      <Animated.View style={{ transform: [{ rotate }] }}><Icon name="ChevronDown" size={14} color={colors.foregroundMuted} /></Animated.View>
    </Pressable>
  </Animated.View>;
}

function MenuItem({ colors, height, still, label, title, onPress }: { colors: Colors; height: number; still: boolean; label: string; title: string; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  const wash = useTween(hovered ? 1 : 0, hovered ? 80 : 160, still);
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${title}`} onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={{ width: ACTION_WIDTH + ACTION_GAP + height, height, borderRadius: 6, overflow: 'hidden', justifyContent: 'center', paddingHorizontal: 10 }}>
    <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.surface2, opacity: wash }} />
    <Label colors={colors}>{label}</Label>
  </Pressable>;
}

function AgentRow({ agent, colors, height, actionHeight, still, phase, shared, error, copyFailed, menuOpen, onMenu, onShare, onCopy }: {
  agent: PaseoAgent; colors: Colors; height: number; actionHeight: number; still: boolean; phase: Phase; shared?: SharedSnapshot; error?: string; copyFailed: boolean; menuOpen: boolean; onMenu(): void; onShare(locked: boolean): void; onCopy(shared: SharedSnapshot): void;
}) {
  const title = agent.title || '未命名会话';
  // A locked link is useless without its password, so it can only be replaced and needs no freshness check.
  const copyable = shared && (!shared.locked || shared.password) ? shared : undefined;
  const { fresh, failed } = useSnapshotFreshness(agent.id, copyable);
  let currentPhase = phase;
  if (shared && phase !== 'pending') currentPhase = !copyable || fresh === false || (failed && fresh !== true) ? 'share' : fresh === true ? phase : 'checking';
  // Keep the mode this conversation was shared in: one click must never turn an encrypted share into plaintext.
  const locked = !!shared?.locked, copying = currentPhase === 'copy' || currentPhase === 'copied';
  const menu = copying ? [{ label: '重新分享', locked: false }, { label: '重新加密分享', locked: true }]
    : [locked ? { label: '分享', locked: false } : { label: '加密分享', locked: true }];
  const busy = currentPhase === 'checking' || currentPhase === 'pending';
  const textInset = { paddingLeft: 32, paddingRight: 8, paddingBottom: 8, fontSize: 13, lineHeight: 18 };
  return <View>
    <View style={{ minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}>
      <View accessibilityRole="image" accessibilityLabel={agent.provider} style={{ width: 16, height: 16 }}><Icon {...providerIcon(agent.provider)} size={16} color={colors.foregroundMuted} /></View>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 14, lineHeight: 18 }}>{title}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: ACTION_GAP }}>
        <ShareAction colors={colors} height={actionHeight} still={still} phase={currentPhase} locked={locked} title={title} onPress={() => { if (copying && shared) onCopy(shared); else onShare(locked); }} />
        <MenuToggle colors={colors} size={actionHeight} still={still} disabled={busy} open={menuOpen && !busy} title={title} onPress={onMenu} />
      </View>
    </View>
    <Collapse open={menuOpen && !busy} still={still}>
      <View style={{ alignItems: 'flex-end', gap: 2, paddingHorizontal: 8, paddingBottom: 4 }}>
        {menu.map(item => <MenuItem key={item.label} colors={colors} height={actionHeight} still={still} label={item.label} title={title} onPress={() => onShare(item.locked)} />)}
      </View>
    </Collapse>
    <Collapse open={!!error} still={still}>
      <Text accessibilityRole="alert" style={{ ...textInset, color: colors.statusDanger }}>{error}</Text>
    </Collapse>
    <Collapse open={failed && !error} still={still}>
      <Text style={{ ...textInset, color: colors.foregroundMuted }}>无法确认快照是否最新，请重新生成分享。</Text>
    </Collapse>
    <Collapse open={copyFailed && fresh === true} still={still}>
      <Text selectable style={{ ...textInset, color: colors.foreground }}>{shared && shareText(shared)}</Text>
    </Collapse>
  </View>;
}

function SkeletonRows({ colors, height, actionHeight, still }: { colors: Colors; height: number; actionHeight: number; still: boolean }) {
  return <FadeIn still={still} delay={120}>
    <View accessibilityLabel="正在读取会话…" style={{ gap: 2 }}>
      {[62, 44, 54].map(width => <View key={width} style={{ height, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 }}>
        <View style={{ width: 16, height: 16, borderRadius: 4, backgroundColor: colors.surface2 }} />
        <View style={{ flex: 1 }}><View style={{ width: `${width}%`, height: 8, borderRadius: 4, backgroundColor: colors.surface2 }} /></View>
        <View style={{ width: ACTION_WIDTH + ACTION_GAP + actionHeight, height: actionHeight, borderRadius: 6, backgroundColor: colors.surface2, opacity: 0.5 }} />
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
      if (id === lookupId) set({ checked: true, lookupError: undefined, links: { ...links, ...created } });
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

/** An installation keeps uploads and known links across popover closes and workspace switches. */
export function createSharePopover() {
  const store = createShareStore();
  return function SharePopover({ workspaceId, theme, layout }: PluginButtonContentProps) {
    const paseo = usePaseo(), rpc = useRpc(shareAgent), lookup = useRpc(listShares), toast = useToast(), colors = theme.colors, still = useReducedMotion();
    const shares = useSyncExternalStore(store.subscribe, store.get);
    const [agents, setAgents] = useState<PaseoAgent[] | null>(null);
    const [listFailed, setListFailed] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [copyFailed, setCopyFailed] = useState<string | null>(null);
    const [menuAgent, setMenuAgent] = useState<string | null>(null);
    const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const open = useRef(false);
    async function refreshLinks() {
      const id = store.lookup();
      try {
        const result = await lookup({});
        if ('error' in result) store.lookupFailed(id, result.error);
        else store.checked(id, result.links);
      } catch { store.lookupFailed(id, '读取分享链接失败，请稍后重试。'); }
    }
    useEffect(() => {
      open.current = true;
      void refreshLinks();
      return () => { open.current = false; clearTimeout(copiedTimer.current); };
    }, []);
    const recentFirst = (entries: PaseoAgent[]) => entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    async function copy(agentId: string, shared: SharedSnapshot, notice = '') {
      clearTimeout(copiedTimer.current);
      try {
        await copyText(shareText(shared));
        toast.show(`${shared.locked ? '链接和密码已复制' : '链接已复制'}${notice}`, { variant: 'success' });
        if (!open.current) return;
        setCopyFailed(null);
        setCopied(agentId);
        copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
      } catch { if (open.current) { setCopied(null); setCopyFailed(agentId); toast.error('复制失败，请复制下方链接。'); } }
    }
    async function share(agentId: string, locked: boolean) {
      const previous = store.get().links[agentId];
      // Sharing again never touches the earlier Gist, so encrypting does not protect the old link.
      const notice = locked && previous && !previous.locked ? '。旧的明文链接仍可打开，需到 GitHub 删除。' : '';
      if (!store.begin(agentId)) return;
      try {
        const result = await rpc(locked ? { agentId, locked } : { agentId }).catch(() => { throw new Error('分享失败，请稍后重试。'); });
        if ('error' in result) throw new Error(result.error);
        store.succeed(agentId, result);
        if (open.current) setCopyFailed(current => current === agentId ? null : current);
        // A closed popover must not overwrite whatever the user has copied since.
        if (open.current) await copy(agentId, result, notice);
        else toast.show(`分享链接已创建${notice}`, { variant: 'success' });
      } catch (error) {
        const message = (error as Error).message;
        store.fail(agentId, message);
        toast.error(message);
      }
    }
    useEffect(() => {
      return observeDirectory(
        (cursor, subscribe) => paseo.agents.list({ filter: { includeArchived: false, includeBackground: true }, page: { limit: 200, cursor }, ...(subscribe ? { subscribe: {} } : {}) }),
        {
            snapshot: entries => {
              setAgents(recentFirst(entries.map(({ agent }) => agent).filter(agent => agent.workspaceId === workspaceId && !agent.archivedAt)));
              setListFailed(false);
            },
            update: message => {
              if (message.type !== 'agent_update') return;
              const update = message.payload;
              setAgents(current => {
                const id = update.kind === 'upsert' ? update.agent.id : update.agentId;
                const remaining = (current ?? []).filter(agent => agent.id !== id);
                if (update.kind === 'upsert' && update.agent.workspaceId === workspaceId && !update.agent.archivedAt) remaining.push(update.agent);
                return recentFirst(remaining);
              });
            },
            error: () => setListFailed(true),
        });
    }, [paseo, workspaceId]);
    const rowHeight = layout.compact ? 56 : 40, actionHeight = layout.compact ? 44 : 30;
    const message = { paddingHorizontal: 8, paddingVertical: 8, fontSize: 13, lineHeight: 18 };
    const phaseOf = (agentId: string): Phase => shares.pending.has(agentId) ? 'pending'
      : copied === agentId ? 'copied'
      : shares.links[agentId] !== undefined ? 'copy'
      : shares.checked ? 'share' : 'checking';
    return <View style={{ margin: -8, ...(layout.compact ? {} : { width: PANEL_WIDTH }) }}>
      {shares.lookupError && <View style={{ padding: 8, gap: 4 }}>
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 13, lineHeight: 18 }}>{shares.lookupError}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="重试读取分享链接" onPress={() => void refreshLinks()} style={{ minHeight: actionHeight, justifyContent: 'center' }}>
          <Text style={{ color: colors.foreground, fontSize: 13 }}>重试</Text>
        </Pressable>
      </View>}
      <Collapse open still={still}>
        {listFailed ? <Text style={{ ...message, color: colors.statusDanger }}>读取会话失败，请重新打开。</Text>
          : agents === null ? <SkeletonRows colors={colors} height={rowHeight} actionHeight={actionHeight} still={still} />
          : agents.length === 0 ? <Text style={{ ...message, color: colors.foregroundMuted }}>暂无会话</Text>
          : <FadeIn still={still}><ScrollView style={{ maxHeight: LIST_MAX_HEIGHT }} contentContainerStyle={{ gap: 2 }} bounces={false}>{agents.map(agent =>
            <AgentRow key={agent.id} agent={agent} colors={colors} height={rowHeight} actionHeight={actionHeight} still={still} phase={phaseOf(agent.id)}
              shared={shares.links[agent.id]} error={shares.errors[agent.id]} copyFailed={copyFailed === agent.id} menuOpen={menuAgent === agent.id}
              onMenu={() => setMenuAgent(current => current === agent.id ? null : agent.id)}
              onShare={locked => { setMenuAgent(null); void share(agent.id, locked); }}
              onCopy={shared => { setMenuAgent(null); void copy(agent.id, shared); }} />)}</ScrollView></FadeIn>}
      </Collapse>
    </View>;
  };
}
