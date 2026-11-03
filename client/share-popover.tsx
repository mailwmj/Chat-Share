import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { usePaseo, useRpc, type PluginButtonContentProps, type PluginClientContext } from '@getpaseo/plugin/client';
import { copyText, useToast } from '@getpaseo/plugin/client/ui';
import { shareAgent } from '../shared/plugin';
import { observeDirectory } from './directory';

type AgentDirectory = Awaited<ReturnType<PluginClientContext['paseo']['agents']['list']>>;
type PaseoAgent = AgentDirectory['entries'][number]['agent'];

/** An installation keeps a pending upload across popover closes and workspace switches. */
export function createSharePopover() {
  let inFlight: Promise<{ url: string }> | undefined;
  const links = new Map<string, string>();
  return function SharePopover({ workspaceId, theme }: PluginButtonContentProps) {
    const paseo = usePaseo(), rpc = useRpc(shareAgent), toast = useToast(), colors = theme.colors;
    const [agents, setAgents] = useState<PaseoAgent[] | null>(null);
    const [listFailed, setListFailed] = useState(false);
    const [link, setLink] = useState(links.get(workspaceId) ?? '');
    const recentFirst = (entries: PaseoAgent[]) => entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const pressed = useRef(false);
    async function copy(url: string) {
      try { await copyText(url); toast.show('链接已复制', { variant: 'success' }); }
      catch { toast.error('复制失败，请复制下方链接。'); }
    }
    const upload = useMutation({
      mutationFn: (agentId: string) => {
        const pending = rpc({ agentId });
        inFlight = pending;
        const clear = () => { if (inFlight === pending) inFlight = undefined; };
        void pending.then(clear, clear);
        return pending;
      },
      onSuccess: async ({ url }) => { links.set(workspaceId, url); setLink(url); await copy(url); },
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
    const text = { color: colors.foreground, fontSize: 14 };
    return <View style={{ gap: 12, minWidth: 260 }}>
      {listFailed ? <Text style={{ ...text, color: colors.statusDanger }}>读取会话失败，请重新打开。</Text>
        : agents === null ? <Text style={text}>正在读取会话…</Text>
        : agents.length === 0 ? <Text style={text}>暂无会话</Text> : agents.map(agent =>
          <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`分享 ${agent.title || '未命名会话'}`}
            disabled={upload.isPending} onPress={() => {
              if (pressed.current || inFlight) return;
              pressed.current = true;
              upload.mutate(agent.id);
            }} style={({ pressed: down }) => ({ paddingVertical: 10, paddingHorizontal: 8, borderRadius: 6, opacity: upload.isPending ? 0.55 : 1, backgroundColor: down ? colors.surface2 : colors.surface0 })}>
            <Text style={text}>{agent.title || '未命名会话'}</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{agent.provider}</Text>
          </Pressable>)}
      {upload.isPending && <Text accessibilityLiveRegion="polite" style={text}>正在分享…</Text>}
      {upload.isError && <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{upload.error.message}</Text>}
      {!!link && <View style={{ gap: 8, borderTopWidth: 1, borderColor: colors.border, paddingTop: 12 }}>
        <Text selectable style={text}>{link}</Text>
        <Pressable accessibilityRole="button" onPress={() => void copy(link)} style={{ paddingVertical: 8 }}><Text style={{ ...text, color: colors.accent }}>复制链接</Text></Pressable>
      </View>}
    </View>;
  };
}
