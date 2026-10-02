import { getSdk } from '../sdk';
import { CONFIG_DIR } from '../settings';

export const EXPORT_DIR = `${CONFIG_DIR}/exports`;

/**
 * The plugin frame cannot start a browser download, so an export is written to a file in the plugin's own folder
 * (and can be copied from the dialog). Returns the path.
 */
export async function saveExport(file: string, text: string): Promise<string> {
  const safe = file.replace(/[^a-zA-Z0-9_.-]/g, '_');
  await getSdk().files.mkdir(EXPORT_DIR).catch(() => undefined);
  const path = `${EXPORT_DIR}/${safe}`;
  await getSdk().files.write(path, text);
  return path;
}
