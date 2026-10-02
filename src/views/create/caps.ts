/** The Linux capabilities Docker knows (without the CAP_ prefix). */
export const CAPS = [
  'AUDIT_CONTROL', 'AUDIT_READ', 'AUDIT_WRITE', 'BLOCK_SUSPEND', 'BPF', 'CHECKPOINT_RESTORE', 'CHOWN', 'DAC_OVERRIDE', 'DAC_READ_SEARCH', 'FOWNER',
  'FSETID', 'IPC_LOCK', 'IPC_OWNER', 'KILL', 'LEASE', 'LINUX_IMMUTABLE', 'MAC_ADMIN', 'MAC_OVERRIDE', 'MKNOD', 'NET_ADMIN', 'NET_BIND_SERVICE',
  'NET_BROADCAST', 'NET_RAW', 'PERFMON', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYSLOG', 'SYS_ADMIN', 'SYS_BOOT', 'SYS_CHROOT', 'SYS_MODULE',
  'SYS_NICE', 'SYS_PACCT', 'SYS_PTRACE', 'SYS_RAWIO', 'SYS_RESOURCE', 'SYS_TIME', 'SYS_TTY_CONFIG', 'WAKE_ALARM',
] as const;

/** The capabilities a container has unless something is dropped. */
export const DEFAULT_CAPS: readonly string[] = [
  'AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'NET_RAW', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT',
];

export const ULIMITS = ['nofile', 'nproc', 'core', 'memlock', 'stack', 'cpu', 'fsize', 'data', 'rss', 'locks', 'msgqueue', 'nice', 'rtprio', 'sigpending'];
