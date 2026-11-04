/**
 * TELEGRAM_BOT_API_PATH_MAP "remotePrefix=localPrefix" maps between the paths
 * the bot-api server sees (remote) and the paths TeleDrive sees (local).
 * - toRemote: local -> remote, applied to file:// upload paths.
 * - toLocal:  remote -> local, applied to file_path returned by getFile.
 */
export interface PathMap {
  remotePrefix: string;
  localPrefix: string;
}

export function parsePathMap(raw: string): PathMap | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) throw new Error('TELEGRAM_BOT_API_PATH_MAP must look like "remotePrefix=localPrefix"');
  const remotePrefix = trimmed.slice(0, eq);
  const localPrefix = trimmed.slice(eq + 1);
  if (!remotePrefix || !localPrefix) {
    throw new Error('TELEGRAM_BOT_API_PATH_MAP must look like "remotePrefix=localPrefix"');
  }
  return { remotePrefix, localPrefix };
}

export function toRemote(map: PathMap | null, localPath: string): string {
  if (!map) return localPath;
  if (localPath === map.localPrefix || localPath.startsWith(map.localPrefix + '/')) {
    return map.remotePrefix + localPath.slice(map.localPrefix.length);
  }
  return localPath;
}

export function toLocal(map: PathMap | null, remotePath: string): string {
  if (!map) return remotePath;
  if (remotePath === map.remotePrefix || remotePath.startsWith(map.remotePrefix + '/')) {
    return map.localPrefix + remotePath.slice(map.remotePrefix.length);
  }
  return remotePath;
}
