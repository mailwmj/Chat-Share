import { useState } from 'react';
import { Text } from 'react-native';
import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, useToast } from '@getpaseo/plugin/client/ui';
import { preferences } from '../shared/plugin';

export function ShareSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [draft, setDraft] = useState<{ viewerUrl: string; fallbackToken: string; revision: string } | null>(null);
  const toast = useToast();
  if (settings.status === 'loading') return <Text style={{ color: theme.colors.foreground }}>正在读取设置…</Text>;
  if (settings.status !== 'ready') return <SettingsSection title="会话分享">
    <SettingsAction label="读取设置失败" actionLabel="重新读取" onPress={() => void settings.reload()} />
  </SettingsSection>;
  const values = draft ?? { ...settings.values, revision: settings.revision };
  const edit = (patch: Partial<typeof values>) => setDraft({ ...values, ...patch });
  return <SettingsSection title="会话分享"><SettingsCard key={values.revision}>
    <SettingsInput label="查看器 URL" initialValue={values.viewerUrl} onChangeText={viewerUrl => edit({ viewerUrl })} />
    <SettingsInput label="备用 GitHub token" secureTextEntry initialValue={values.fallbackToken} onChangeText={fallbackToken => edit({ fallbackToken })} />
    <SettingsAction label={settings.saveError ? '保存失败，请检查地址或重新读取设置。' : ''} actionLabel={settings.saving ? '正在保存…' : '保存'} disabled={settings.saving}
      onPress={() => void (async () => {
        if (await settings.save({ viewerUrl: values.viewerUrl, fallbackToken: values.fallbackToken }, values.revision)) {
          setDraft(null); toast.show('设置已保存', { variant: 'success' });
        }
      })()} />
  </SettingsCard></SettingsSection>;
}
