/** Scheduled volume backups: parsing of the backup folder listing. Pure code. */
export interface BackupFile {
  name: string;
  size: number;
  /** "2026-10-02 19:19", as `ls` prints it (the machine's time). */
  when: string;
}

/** Output of `ls -l --time-style=long-iso <dir>`: the .tar files, newest first. */
export function parseBackupList(out: string): BackupFile[] {
  const files: BackupFile[] = [];
  for (const line of out.split('\n')) {
    const m = /^-\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s+(\S+\.tar)$/.exec(line.trim());
    if (m) files.push({ name: m[3], size: Number(m[1]), when: m[2] });
  }
  return files.sort((a, b) => b.name.localeCompare(a.name));
}

export const BACKUP_DIR = '/var/backups/ervisio-docker';
export const KEEP_DEFAULT = 7;
export const validKeep = (s: string): boolean => /^[1-9][0-9]{0,2}$/.test(s);
