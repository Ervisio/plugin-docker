import { UPDATE_INTERVALS } from '../../api/gitMeta';
import { NOTIFY_MODES, type JobSchedule, type NotifyMode } from '../../api/jobs';
import { t } from '../../i18n';
import { Checkbox, Input, Segmented, Select } from '../../kit';

export type Off = { off: true };
export type ScheduleValue = JobSchedule | Off;

export const isOff = (v: ScheduleValue): v is Off => 'off' in v;

/** Seconds as "15 minutes", "6 hours". */
export const everyText = (s: number): string => (s % 86400 === 0 ? t('sched.days', { n: s / 86400 }) : s % 3600 === 0 ? t('sched.hours', { n: s / 3600 }) : t('sched.minutes', { n: Math.round(s / 60) }));

export function scheduleLabel(s: { every?: number; at?: string[]; days?: number[] } | undefined): string {
  if (!s) return t('sched.manual');
  if (s.every) return t('sched.everyN', { every: everyText(s.every) });
  if (s.at?.length) return t(s.days?.length ? 'sched.atDays' : 'sched.at', { time: s.at.join(', '), days: (s.days ?? []).map((d) => t(`sched.day.${d}`)).join(', ') });
  return t('sched.manual');
}

/**
 * Picker for how often a job runs: a fixed interval, or times of the day (with days of the week). `intervals` are the
 * choices in seconds; the first one that is shorter than a minute is never offered (the daemon's floor is 60 s).
 */
export function SchedulePicker({ value, onChange, intervals = UPDATE_INTERVALS, allowOff = true }: {
  value: ScheduleValue;
  onChange(v: ScheduleValue): void;
  intervals?: number[];
  allowOff?: boolean;
}) {
  const kind = isOff(value) ? 'off' : 'every' in value ? 'every' : 'at';
  const setKind = (k: string) => {
    if (k === 'off') onChange({ off: true });
    else if (k === 'every') onChange({ every: intervals[Math.min(2, intervals.length - 1)] });
    else onChange({ at: ['03:30'] });
  };
  return (
    <div className="dk-jb-sched">
      <Segmented
        aria-label={t('sched.title')}
        value={kind}
        options={[
          ...(allowOff ? [{ value: 'off', label: t('sched.off') }] : []),
          { value: 'every', label: t('sched.every') },
          { value: 'at', label: t('sched.atTime') },
        ]}
        onChange={setKind}
      />
      {'every' in value && (
        <Select label={t('sched.interval')} value={String(value.every)} options={intervals.map((s) => ({ value: String(s), label: everyText(s) }))} onChange={(v) => onChange({ every: Number(v) })} />
      )}
      {'at' in value && (
        <>
          <Input label={t('sched.time')} type="time" value={value.at[0] ?? '03:30'} onChange={(e) => e.target.value && onChange({ at: [e.target.value], days: value.days })} />
          <div className="dk-jb-days" role="group" aria-label={t('sched.days.label')}>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <Checkbox key={d} checked={!value.days?.length || value.days.includes(d)} label={t(`sched.day.${d}`)} onChange={(on) => {
                const cur = value.days?.length ? value.days : [0, 1, 2, 3, 4, 5, 6];
                const next = on ? [...new Set([...cur, d])] : cur.filter((x) => x !== d);
                onChange({ at: value.at, days: next.length === 7 || next.length === 0 ? undefined : next.sort() });
              }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function NotifyPicker({ value, onChange }: { value: NotifyMode; onChange(m: NotifyMode): void }) {
  return (
    <Select
      label={t('notify.mode')}
      hint={t('notify.mode.hint')}
      value={value}
      options={NOTIFY_MODES.map((m) => ({ value: m, label: t(`notify.mode.${m}`) }))}
      onChange={(v) => onChange(v as NotifyMode)}
    />
  );
}
