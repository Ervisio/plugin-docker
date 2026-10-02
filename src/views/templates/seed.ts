import { docker } from '../../api/engine';
import { isSecretName } from '../../api/dotenv';
import { hueFor, slug, type Template, type TemplateVar } from '../../api/templateModel';
import type { ContainerInspect } from '../../api/types';
import { parseHostPort, specFromInspect, type Base } from '../create/model';

/**
 * A container template from a container's settings ("Save as template"). Secret-looking environment values are left
 * out and asked for at install; the other values are kept. Named volumes become `<template>-<folder>` so two
 * installs do not share data.
 */
export async function seedFromContainer(ins: ContainerInspect): Promise<Template> {
  let cfg: Base['imageConfig'];
  try {
    cfg = (await docker.get<{ Config?: Base['imageConfig'] }>(`/images/${encodeURIComponent(ins.Image)}/json`)).Config;
  } catch {
    cfg = undefined;
  }
  const { spec } = specFromInspect(ins, cfg);
  const title = spec.name;
  const key = slug(title);
  const variables: TemplateVar[] = [];
  const env: { key: string; value: string }[] = [];
  for (const e of spec.env) {
    if (!e.key.trim()) continue;
    if (isSecretName(e.key)) {
      variables.push({ name: e.key, label: e.key, default: '', type: 'password', required: false, generate: true });
      env.push({ key: e.key, value: `\${${e.key}}` });
    } else env.push({ key: e.key, value: e.value });
  }
  return {
    id: '',
    source: 'custom',
    sourceName: 'Custom',
    name: title,
    description: '',
    category: 'Other',
    hue: hueFor(title),
    type: 'container',
    featured: false,
    variables,
    container: {
      image: spec.image,
      ports: spec.ports.filter((p) => p.container).map((p) => ({ host: parseHostPort(p.host).port, container: p.container, proto: p.proto })).map((p) => ({ ...p, host: p.host || p.container })),
      volumes: spec.mounts.filter((m) => m.target).map((m) => ({
        source: m.kind === 'bind' ? m.source : `${key}-${slug(m.target.split('/').filter(Boolean).pop() ?? 'data')}`,
        target: m.target,
        readOnly: m.ro || undefined,
      })),
      env,
      restart: spec.restart,
      command: spec.command || undefined,
      hostname: spec.hostname || undefined,
      network: spec.network && spec.network !== 'bridge' ? spec.network : undefined,
      privileged: spec.privileged || undefined,
      labels: spec.labels.filter((l) => l.key && !l.key.startsWith('com.docker.compose.')).map((l) => ({ key: l.key, value: l.value })),
    },
  };
}
