import { useState } from 'react';
import { docker, errorText } from '../../api/engine';
import { networks } from '../../api/resources';
import type { ContainerInspect } from '../../api/types';
import { t } from '../../i18n';
import { Button, IconButton, Icon, Input, Select, toast } from '../../kit';
import { Confirm } from '../stack/Confirm';
import { nameOf } from './util';

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** Networks the container cannot join or leave while it uses one of these modes. */
const fixedMode = (mode?: string): boolean => mode === 'host' || mode === 'none' || !!mode?.startsWith('container:');

/** Connected networks of a container, with a form to join another one and a Leave action. */
export function NetworksCard({ inspect: c, onChanged }: { inspect: ContainerInspect; onChanged(): void }) {
  const all = networks.use().data ?? [];
  const joined = Object.entries(c.NetworkSettings.Networks ?? {});
  const mode = c.HostConfig.NetworkMode;
  const locked = fixedMode(mode);
  const free = all.filter((n) => n.Driver !== 'host' && n.Driver !== 'null' && !joined.some(([name]) => name === n.Name));
  const [pick, setPick] = useState('');
  const [ip, setIp] = useState('');
  const [aliases, setAliases] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<{ name: string; id: string } | null>(null);
  const name = nameOf(c.Name);

  const aliasList = aliases.split(',').map((a) => a.trim()).filter(Boolean);
  const ipBad = ip.trim() !== '' && !IPV4.test(ip.trim());
  const aliasBad = aliasList.some((a) => !ALIAS.test(a));
  const net = free.find((n) => n.Id === pick);

  const refresh = () => {
    onChanged();
    void networks.refresh();
    setTimeout(onChanged, 800);
  };

  const join = async () => {
    if (!net) return;
    setBusy(true);
    try {
      const ep: Record<string, unknown> = {};
      if (ip.trim()) ep.IPAMConfig = { IPv4Address: ip.trim() };
      if (aliasList.length) ep.Aliases = aliasList;
      await docker.post(`/networks/${net.Id}/connect`, undefined, { Container: c.Id, EndpointConfig: ep });
      toast.ok(t('res.networks.connected', { name, network: net.Name }));
      setPick('');
      setIp('');
      setAliases('');
      refresh();
    } catch (e) {
      toast.err(t('res.networks.connectFail', { name }), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!leaving) return;
    try {
      await docker.post(`/networks/${leaving.id}/disconnect`, undefined, { Container: c.Id, Force: false });
      toast.ok(t('res.networks.disconnected', { name, network: leaving.name }));
      refresh();
    } catch (e) {
      toast.err(t('res.networks.disconnectFail', { name }), errorText(e));
    }
  };

  return (
    <div className="dk-card">
      <h3>{t('container.networks')}</h3>
      {joined.length === 0 ? <p className="dk-muted">{t('container.networksNone')}</p> : (
        <div className="dk-c-nets">
          {joined.map(([nn, n]) => {
            const al = (n.Aliases ?? []).filter((a) => !c.Id.startsWith(a));
            return (
              <div key={nn} className="dk-c-row dk-c-row--wrap">
                <b>{nn}</b>
                <span className="dk-mono">{n.IPAddress || '–'}</span>
                {n.Gateway && <span className="dk-muted">{t('container.gateway', { ip: n.Gateway })}</span>}
                {al.length > 0 && <span className="dk-muted">{t('container.aliases', { list: al.join(', ') })}</span>}
                {!locked && <span className="dk-c-row-end"><IconButton size="sm" variant="ghost" icon="close" label={t('container.net.leave', { network: nn })} onClick={() => setLeaving({ name: nn, id: n.NetworkID ?? nn })} /></span>}
              </div>
            );
          })}
        </div>
      )}
      <h3 className="dk-c-h3-gap">{t('container.net.join')}</h3>
      {locked ? (
        <p className="dk-muted"><Icon name="info" /> {t('container.net.locked', { mode: mode ?? '' })}</p>
      ) : free.length === 0 ? (
        <p className="dk-muted">{t('container.net.none')}</p>
      ) : (
        <div className="dk-form dk-form--col" onKeyDown={(e) => { if (e.key === 'Enter' && net && !ipBad && !aliasBad && !busy) { e.preventDefault(); void join(); } }}>
          <div className="dk-fields">
            <Select label={t('container.net.network')} value={pick} onChange={setPick} options={[{ value: '', label: t('container.net.pick') }, ...free.map((n) => ({ value: n.Id, label: n.Name }))]} />
            <Input mono label={t('container.net.ip')} placeholder="172.20.0.10" value={ip} onChange={(e) => setIp(e.target.value)} error={ipBad ? t('container.net.ipBad') : undefined} hint={ipBad ? undefined : t('container.net.ipHint')} />
            <Input mono label={t('container.net.aliases')} placeholder="web, api" value={aliases} onChange={(e) => setAliases(e.target.value)} error={aliasBad ? t('container.net.aliasBad') : undefined} hint={aliasBad ? undefined : t('container.net.aliasesHint')} />
          </div>
          <div><Button variant="primary" icon="link" disabled={!net || ipBad || aliasBad} loading={busy} onClick={() => void join()}>{t('container.net.joinBtn')}</Button></div>
        </div>
      )}
      <Confirm
        open={!!leaving}
        onClose={() => setLeaving(null)}
        onConfirm={leave}
        title={t('container.net.leaveTitle', { name, network: leaving?.name ?? '' })}
        description={t('container.net.leaveText')}
        confirmLabel={t('container.net.leaveConfirm')}
        icon="link"
      />
    </div>
  );
}
