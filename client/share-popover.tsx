import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Platform, Pressable, Text, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { usePaseo, useRpc, type PluginButtonContentProps, type PluginClientContext } from '@getpaseo/plugin/client';
import { copyText, Icon, ScrollView, useToast } from '@getpaseo/plugin/client/ui';
import { shareAgent } from '../shared/plugin';
import { observeDirectory } from './directory';

type AgentDirectory = Awaited<ReturnType<PluginClientContext['paseo']['agents']['list']>>;
type PaseoAgent = AgentDirectory['entries'][number]['agent'];

type Colors = PluginButtonContentProps['theme']['colors'];

const settle = Easing.bezier(0.25, 0.8, 0.25, 1);
const nativeDriver = Platform.OS !== 'web';
const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;
const COPIED_MS = 1600;

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

function AgentRow({ agent, colors, height, still, active, dimmed, disabled, onPress }: {
  agent: PaseoAgent; colors: Colors; height: number; still: boolean; active: boolean; dimmed: boolean; disabled: boolean; onPress(): void;
}) {
  const [hovered, setHovered] = useState(false), [down, setDown] = useState(false);
  useEffect(() => { if (disabled) { setHovered(false); setDown(false); } }, [disabled]);
  const lit = active || hovered || down;
  const wash = useTween(lit ? 1 : 0, lit ? 80 : 160, still);
  const scale = useTween(down ? 0.985 : 1, down ? 60 : 140, still);
  const opacity = useTween(dimmed ? 0.45 : 1, 150, still);
  const title = agent.title || '未命名会话';
  return <Animated.View style={{ opacity, transform: [{ scale }] }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`分享 ${title}`} accessibilityState={{ selected: active, disabled }} disabled={disabled} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onPressIn={() => setDown(true)} onPressOut={() => setDown(false)}
      style={{ minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8 }}>
      <Animated.View pointerEvents="none" style={{ ...fill, borderRadius: 6, backgroundColor: colors.surface2, opacity: wash }} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 14, lineHeight: 18 }}>{title}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{agent.provider}</Text>
    </Pressable>
  </Animated.View>;
}

function SkeletonRows({ colors, height, still }: { colors: Colors; height: number; still: boolean }) {
  return <FadeIn still={still} delay={120}>
    <View accessibilityLabel="正在读取会话…">
      {[62, 44, 54].map(width => <View key={width} style={{ height, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8 }}>
        <View style={{ flex: 1 }}><View style={{ width: `${width}%`, height: 8, borderRadius: 4, backgroundColor: colors.surface2 }} /></View>
        <View style={{ width: 34, height: 6, borderRadius: 3, backgroundColor: colors.surface2 }} />
      </View>)}
    </View>
  </FadeIn>;
}

function CopyButton({ colors, height, still, disabled, copied, onPress }: { colors: Colors; height: number; still: boolean; disabled: boolean; copied: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  useEffect(() => { if (disabled) setHovered(false); }, [disabled]);
  const wash = useTween(hovered ? 0.08 : 0, hovered ? 80 : 160, still);
  const opacity = useTween(disabled ? 0.5 : 1, 150, still);
  const idle = useTween(copied ? 0 : 1, 100, still);
  const done = useTween(copied ? 1 : 0, copied ? 180 : 100, still);
  const pop = useTween(copied ? 1 : 0.6, 200, still, { easing: Easing.out(Easing.back(2)) });
  return <Animated.View style={{ opacity }}>
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={{ height, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: 6, overflow: 'hidden', backgroundColor: colors.surface2 }}>
      <Animated.View pointerEvents="none" style={{ ...fill, backgroundColor: colors.foreground, opacity: wash }} />
      <View style={{ width: 14, height: 14 }}>
        <Animated.View style={{ ...fill, opacity: idle }}><Icon name="Copy" size={14} color={colors.foregroundMuted} /></Animated.View>
        <Animated.View style={{ ...fill, opacity: done, transform: [{ scale: pop }] }}><Icon name="Check" size={14} color={colors.statusSuccess} /></Animated.View>
      </View>
      <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 16 }}>复制链接</Text>
    </Pressable>
  </Animated.View>;
}

function LinkField({ colors, height, still, link, pending, expanded }: { colors: Colors; height: number; still: boolean; link: string; pending: boolean; expanded: boolean }) {
  const url = useTween(pending ? 0 : 1, pending ? 80 : 160, still, { delay: pending ? 0 : 80 });
  const status = useTween(pending ? 1 : 0, pending ? 140 : 80, still, { delay: pending ? 80 : 0 });
  const statusPresent = usePresence(pending, still ? 0 : 100);
  return <View style={{ flex: 1, minWidth: 0, minHeight: height, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: (height - 16) / 2, borderRadius: 6, backgroundColor: colors.surface0 }}>
    <Animated.View style={{ opacity: url }}>
      <Text selectable numberOfLines={expanded ? undefined : 1} style={{ color: colors.foreground, fontSize: 13, lineHeight: 16 }}>{link}</Text>
    </Animated.View>
    {statusPresent && <Animated.View pointerEvents="none" style={{ ...fill, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, opacity: status }}>
      <ActivityIndicator size="small" color={colors.foregroundMuted} style={{ transform: [{ scale: 0.7 }], width: 16, height: 16 }} />
      <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 16 }}>正在分享…</Text>
    </Animated.View>}
  </View>;
}

/** An installation keeps a pending upload across popover closes and workspace switches. */
export function createSharePopover() {
  let inFlight: Promise<{ url: string }> | undefined;
  const links = new Map<string, { url: string; agentId: string }>();
  return function SharePopover({ workspaceId, theme, layout }: PluginButtonContentProps) {
    const paseo = usePaseo(), rpc = useRpc(shareAgent), toast = useToast(), colors = theme.colors, still = useReducedMotion();
    const [agents, setAgents] = useState<PaseoAgent[] | null>(null);
    const [listFailed, setListFailed] = useState(false);
    const [shared, setShared] = useState(links.get(workspaceId));
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(copiedTimer.current), []);
    const recentFirst = (entries: PaseoAgent[]) => entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const pressed = useRef(false);
    async function copy(url: string) {
      clearTimeout(copiedTimer.current);
      try {
        await copyText(url);
        toast.show('链接已复制', { variant: 'success' });
        setCopyState('copied');
        copiedTimer.current = setTimeout(() => setCopyState('idle'), COPIED_MS);
      } catch { setCopyState('failed'); toast.error('复制失败，请复制下方链接。'); }
    }
    const upload = useMutation({
      mutationFn: (agentId: string) => {
        const pending = rpc({ agentId }).catch(() => { throw new Error('分享失败，请稍后重试。'); }).then(result => {
          if ('error' in result) throw new Error(result.error);
          return result;
        });
        inFlight = pending;
        const clear = () => { if (inFlight === pending) inFlight = undefined; };
        void pending.then(clear, clear);
        return pending;
      },
      onMutate: () => { clearTimeout(copiedTimer.current); setCopyState('idle'); },
      onSuccess: async ({ url }, agentId) => { const next = { url, agentId }; links.set(workspaceId, next); setShared(next); await copy(url); },
      onError: (error: Error) => toast.error(error.message),
      onSettled: () => { pressed.current = false; },
      retry: false,
    });
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
    const rowHeight = layout.compact ? 40 : 32, controlHeight = layout.compact ? 40 : 32;
    const message = { paddingHorizontal: 8, paddingVertical: 8, fontSize: 13, lineHeight: 18 };
    const activeId = upload.isPending ? upload.variables : shared?.agentId;
    return <View style={{ margin: -8, ...(layout.compact ? {} : { width: 348 }) }}>
      <Collapse open still={still}>
        {listFailed ? <Text style={{ ...message, color: colors.statusDanger }}>读取会话失败，请重新打开。</Text>
          : agents === null ? <SkeletonRows colors={colors} height={rowHeight} still={still} />
          : agents.length === 0 ? <Text style={{ ...message, color: colors.foregroundMuted }}>暂无会话</Text>
          : <FadeIn still={still}><ScrollView style={{ maxHeight: 288 }} contentContainerStyle={{ gap: 2 }} bounces={false}>{agents.map(agent =>
            <AgentRow key={agent.id} agent={agent} colors={colors} height={rowHeight} still={still} active={agent.id === activeId}
              dimmed={upload.isPending && agent.id !== activeId} disabled={upload.isPending} onPress={() => {
                if (pressed.current || inFlight) return;
                pressed.current = true;
                upload.mutate(agent.id);
              }} />)}</ScrollView></FadeIn>}
      </Collapse>
      <Collapse open={upload.isError} still={still}>
        <Text accessibilityRole="alert" style={{ ...message, color: colors.statusDanger }}>{upload.error?.message}</Text>
      </Collapse>
      <Collapse open={upload.isPending || !!shared} still={still}>
        <View style={{ marginTop: 4, paddingTop: 8, paddingHorizontal: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderTopWidth: 1, borderColor: colors.border }}>
          <LinkField colors={colors} height={controlHeight} still={still} link={shared?.url ?? ''} pending={upload.isPending} expanded={copyState === 'failed'} />
          <CopyButton colors={colors} height={controlHeight} still={still} disabled={!shared || upload.isPending} copied={copyState === 'copied'} onPress={() => { if (shared) void copy(shared.url); }} />
        </View>
      </Collapse>
    </View>;
  };
}
