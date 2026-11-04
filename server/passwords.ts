import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SHARE_PASSWORD, isObject } from '../shared/format';

export interface PasswordStore {
  read(): Promise<Record<string, string>>;
  save(gistId: string, password: string): Promise<void>;
}

function defaultPath() {
  return join(process.env.PASEO_HOME || join(homedir(), '.paseo'), 'plugin-data', 'chat-share', 'share-passwords.json');
}

/**
 * Lets 复制链接 still include the password after a restart. The SDK offers plugins no storage, and
 * the Gist cannot hold it. Plaintext with owner-only access, matching how `gh` keeps its token here.
 */
export function filePasswordStore(path = defaultPath()): PasswordStore {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Record<string, string>> => {
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) {
      // Any other failure must reject: treating it as empty would let the next save erase every saved password.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { return {}; }
    if (!isObject(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && SHARE_PASSWORD.test(entry[1])));
  };
  return {
    read,
    save(gistId, password) {
      // Saves run one at a time so simultaneous shares cannot overwrite each other's entry.
      const saved = queue.then(async () => {
        const passwords = { ...await read(), [gistId]: password }, temporary = `${path}.${process.pid}.tmp`;
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(passwords), { mode: 0o600 });
        await rename(temporary, path);
      });
      queue = saved.catch(() => {});
      return saved;
    },
  };
}
