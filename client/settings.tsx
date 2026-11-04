import { t } from './i18n';
import { useState } from 'react';
import { Text } from 'react-native';
import { useSettings, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, useToast } from '@getpaseo/plugin/client/ui';
import { preferences } from '../shared/plugin';

export function ShareSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [draft, setDraft] = useState<{ viewerUrl: string; revision: string } | null>(null);
  const toast = useToast();
  if (settings.status === 'loading') return <Text style={{ color: theme.colors.foreground }}>{t('正在读取设置…', 'Loading settings…')}</Text>;
  if (settings.status !== 'ready') return <SettingsSection title={t('会话分享', 'Conversation sharing')}>
    <SettingsAction label={t('读取设置失败', 'Could not load settings')} actionLabel={t('重新读取', 'Reload')} onPress={() => void settings.reload()} />
  </SettingsSection>;
  const values = draft ?? { ...settings.values, revision: settings.revision };
  const edit = (patch: Partial<typeof values>) => setDraft({ ...values, ...patch });
  return <SettingsSection title={t('会话分享', 'Conversation sharing')}><SettingsCard key={values.revision}>
    <SettingsInput label={t('查看器 URL', 'Viewer URL')} initialValue={values.viewerUrl} onChangeText={viewerUrl => edit({ viewerUrl })} />
    <SettingsAction label={settings.saveError ? t('保存失败，请检查地址或重新读取设置。', 'Save failed. Check the URL or reload settings.') : ''} actionLabel={settings.saving ? t('正在保存…', 'Saving…') : t('保存', 'Save')} disabled={settings.saving}
      onPress={() => void (async () => {
        if (await settings.save({ viewerUrl: values.viewerUrl }, values.revision)) {
          setDraft(null); toast.show(t('设置已保存', 'Settings saved'), { variant: 'success' });
        }
      })()} />
  </SettingsCard></SettingsSection>;
}
