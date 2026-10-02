import { useEffect, useMemo, useRef, useState } from 'react';
import { deployStack, isValidStackName, STACKS_DIR } from '../api/compose';
import { cloneStack, gitTools, lsRemote, removeCredentials, storeCredentials, GitError, type GitTools, type RemoteRefs } from '../api/git';
import { hasSecretInUrl, urlKind, validFile, validRef, validUrl } from '../api/gitMeta';
import { jobsApi, jobsAvailable, jobsElsewhere, pollJob, type NotifyMode } from '../api/jobs';
import { t } from '../i18n';
import { Button, Card, Checkbox, Icon, Input, Segmented, Select, Textarea, toast } from '../kit';
import { back, navigate } from '../router';
import { PageHeader } from '../ui/PageHeader';
import { SetupCard } from './stack/SetupCard';
import { DeployOutput } from './stack/DeployCard';
import { logged, useDeploy } from './stack/deployLog';
import { useStacks } from './stack/useStacks';
import { LocalOnlyNote } from './jobs/shared';
import { NotifyPicker, SchedulePicker, isOff, type ScheduleValue } from './jobs/Schedule';


type Auth = 'none' | 'token' | 'ssh';

const errText = (e: unknown): string => (e instanceof GitError ? `${t(e.key)}${e.detail ? ` (${e.detail})` : ''}` : (e as Error).message);

/** Route { view: 'stack-git' }: make a stack from a Git repository. */
export function GitStackPage() {
  const { stacks, sources, reload } = useStacks();
  const [tools, setTools] = useState<GitTools | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [file, setFile] = useState('compose.yaml');
  const [auth, setAuth] = useState<Auth>('none');
  const [user, setUser] = useState('');
  const [secret, setSecret] = useState('');
  const [refs, setRefs] = useState<RemoteRefs | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState('');
  const [deploy, setDeploy] = useState(true);
  const [pull, setPull] = useState(true);
  const [auto, setAuto] = useState<ScheduleValue>({ off: true });
  const [mode, setMode] = useState<NotifyMode>('f');
  const [busy, setBusy] = useState(false);
  const out = useDeploy(name || '-');
  const started = useRef(false);

  useEffect(() => { void gitTools().then(setTools, () => setTools({ git: false, ssh: false, version: '' })); }, []);

  const kind = urlKind(url.trim());
  const urlErr = url && !validUrl(url.trim()) ? (hasSecretInUrl(url.trim()) ? t('gitnew.url.secret') : t('gitnew.url.bad')) : hasSecretInUrl(url.trim()) ? t('gitnew.url.secret') : undefined;
  const exists = stacks.some((s) => s.name === name);
  const nameErr = name && !isValidStackName(name) ? t('stacks.new.nameBad') : exists ? t('stacks.new.nameTaken') : undefined;
  const refErr = ref && !validRef(ref) ? t('gitnew.ref.bad') : undefined;
  const fileErr = file && !validFile(file) ? t('gitnew.file.bad') : undefined;
  const authErr = auth === 'token' && kind === 'ssh' ? t('gitnew.auth.tokenSsh') : auth === 'ssh' && (kind === 'https' || kind === 'http') ? t('gitnew.auth.sshHttp') : undefined;
  const needSecret = auth !== 'none' && !secret.trim();
  const ready = !!name && !nameErr && !!url && !urlErr && !!ref && !refErr && !!file && !fileErr && !authErr && !needSecret && !!tools?.git && !busy;

  const secretFor = () => ({ kind: auth, username: user, secret });

  const check = async () => {
    if (!name || nameErr || !url || urlErr || authErr) return;
    setChecking(true);
    setCheckErr('');
    setRefs(null);
    try {
      await storeCredentials(name, url.trim(), secretFor());
      try {
        const r = await lsRemote(name, url.trim());
        setRefs(r);
        if (!ref) setRef(r.head ?? r.branches[0] ?? '');
      } finally {
        await removeCredentials(name);
      }
    } catch (e) {
      setCheckErr(errText(e));
    } finally {
      setChecking(false);
    }
  };

  const options = useMemo(() => {
    if (!refs) return [];
    return [
      ...refs.branches.map((b) => ({ value: b, label: `${b}${b === refs.head ? ` (${t('gitnew.ref.default')})` : ''}` })),
      ...refs.tags.map((x) => ({ value: x, label: `${x} (${t('gitnew.ref.tag')})` })),
    ];
  }, [refs]);

  const create = async () => {
    setBusy(true);
    started.current = true;
    let cloned = false;
    try {
      const meta = await logged(name, t('gitnew.cloning'), async (on) => {
        try {
          await cloneStack(name, { url: url.trim(), ref, compose: file, auth }, secretFor(), on);
          cloned = true;
          on('stdout', t('gitnew.cloned'));
          return 0;
        } catch (e) {
          on('stderr', errText(e));
          return 1;
        }
      });
      if (meta !== 0) {
        toast.err(t('gitnew.fail'), t('gitnew.failText'));
        return;
      }
      void reload();
      let code = 0;
      if (deploy) code = await logged(name, t('stacks.deploy.title'), (on) => deployStack(name, { pull }, on, file));
      if (!isOff(auto) && jobsAvailable()) {
        try {
          await jobsApi().create({ job: pollJob(mode), name: `Update ${name}`, params: { name, ref, file }, schedule: auto });
        } catch (e) {
          toast.err(t('auto.saveFail'), (e as Error).message);
        }
      }
      toast[code === 0 ? 'ok' : 'err'](code === 0 ? t('gitnew.done', { name }) : t('stacks.runFail'), code === 0 ? undefined : t('stacks.runFailText'));
      await reload();
      navigate({ view: 'stack', name }, { replace: true });
    } finally {
      setBusy(false);
      void cloned;
    }
  };

  const header = <PageHeader icon="git" title={t('gitnew.title')} subtitle={t('gitnew.sub', { dir: STACKS_DIR })} back />;
  if (jobsElsewhere()) return <>{header}<LocalOnlyNote /></>;
  if (sources && !sources.folder) return <>{header}<SetupCard onDone={() => void reload()} /></>;

  return (
    <>
      {header}
      {tools && !tools.git && (
        <div className="dk-jb-warn" role="alert">
          <Icon name="alert" />
          <div><b>{t('gitnew.nogit.title')}</b><p>{t('gitnew.nogit.text')}</p></div>
        </div>
      )}
      <div className="dk-sk-new">
        <Card className="dk-sk-edcard">
          <div className="dk-gn-form">
            <Input label={t('stacks.new.name')} value={name} mono placeholder="my-app" error={nameErr} hint={nameErr ? undefined : t('stacks.new.nameHint', { dir: `${STACKS_DIR}/${name || '<name>'}` })} onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={63} autoFocus />
            <Input label={t('gitnew.url')} value={url} mono placeholder="https://github.com/org/repo.git" error={urlErr} hint={urlErr ? undefined : t('gitnew.url.hint')} onChange={(e) => { setUrl(e.target.value); setRefs(null); }} />

            <div className="dk-gn-auth">
              <span className="dk-gn-l">{t('gitnew.auth')}</span>
              <Segmented aria-label={t('gitnew.auth')} value={auth} options={[{ value: 'none', label: t('gitnew.auth.none') }, { value: 'token', label: t('gitnew.auth.token') }, { value: 'ssh', label: t('gitnew.auth.ssh') }]} onChange={(v) => { setAuth(v as Auth); setRefs(null); }} />
              {authErr && <p className="dk-sk-err">{authErr}</p>}
              {auth === 'token' && (
                <div className="dk-fields dk-fields--2">
                  <Input label={t('gitnew.user')} value={user} placeholder="git" hint={t('gitnew.user.hint')} autoComplete="off" onChange={(e) => setUser(e.target.value)} />
                  <Input label={t('gitnew.token')} type="password" value={secret} autoComplete="off" onChange={(e) => setSecret(e.target.value)} />
                </div>
              )}
              {auth === 'ssh' && (
                <>
                  <Textarea mono rows={5} label={t('gitnew.key')} value={secret} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" onChange={(e) => setSecret(e.target.value)} />
                  {tools && !tools.ssh && <p className="dk-sk-err">{t('gitnew.nossh')}</p>}
                  <p className="dk-muted">{t('gitnew.key.hint')}</p>
                </>
              )}
              {auth !== 'none' && <p className="dk-muted"><Icon name="lock" /> {t('gitnew.secret.where')}</p>}
            </div>

            <div className="dk-gn-ref">
              {options.length ? (
                <Select label={t('gitnew.ref')} value={ref} options={options} onChange={setRef} />
              ) : (
                <Input label={t('gitnew.ref')} value={ref} mono placeholder="main" error={refErr} hint={t('gitnew.ref.hint')} onChange={(e) => setRef(e.target.value)} />
              )}
              <Button icon="search" loading={checking} disabled={!name || !!nameErr || !url || !!urlErr || !!authErr || needSecret || !tools?.git} onClick={() => void check()}>{t('gitnew.check')}</Button>
            </div>
            {checkErr && <p className="dk-sk-err" role="alert">{checkErr}</p>}
            {refs && <p className="dk-muted">{t('gitnew.found', { branches: refs.branches.length, tags: refs.tags.length })}</p>}
            <Input label={t('gitnew.file')} value={file} mono error={fileErr} hint={t('gitnew.file.hint')} onChange={(e) => setFile(e.target.value)} />
          </div>
        </Card>
        <div className="dk-sk-col">
          <Card title={t('gitnew.options')}>
            <Checkbox checked={deploy} onChange={setDeploy} label={t('gitnew.deploy')} />
            {deploy && <Checkbox checked={pull} onChange={setPull} label={t('stacks.pullFirst')} />}
            {jobsAvailable() ? (
              <div className="dk-jb-form">
                <span className="dk-gn-l">{t('auto.title')}</span>
                <SchedulePicker value={auto} onChange={setAuto} />
                {!isOff(auto) && <NotifyPicker value={mode} onChange={setMode} />}
              </div>
            ) : (
              <p className="dk-muted">{t('auto.needs05')}</p>
            )}
            <Button variant="primary" icon="git" block loading={busy} disabled={!ready} onClick={() => void create()}>{deploy ? t('gitnew.createDeploy') : t('gitnew.createOnly')}</Button>
            <Button block variant="ghost" onClick={back}>{t('common.cancel')}</Button>
          </Card>
          {started.current && <Card title={t('gitnew.output')}><DeployOutput state={out} /></Card>}
        </div>
      </div>
    </>
  );
}

