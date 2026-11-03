import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { readSnapshot, type Refetch } from '../shared/snapshot';
import { toShare } from '../shared/convert';

// Use the user's existing CLI transport and credentials, never copy credentials into the repo.
const cliRoot = process.env.PASEO_CLI_ROOT || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@getpaseo/cli');
const moduleAt = (path: string) => import(pathToFileURL(join(cliRoot, path)).href);
const { connectToDaemon } = await moduleAt('dist/utils/client.js');
const { selectDaemonTarget } = await moduleAt('dist/utils/daemon-target.js');
const { createPaseoApi } = await moduleAt('node_modules/@getpaseo/client/dist/index.js');
const output = resolve('.local');
await mkdir(output, { recursive: true });
// SDK diagnostics must not accidentally print provider payloads.
console.log = console.warn = console.error = console.debug = () => {};
const client = await connectToDaemon({ target: selectDaemonTarget({}) });
const paseo = createPaseoApi(client);
try {
  const page = await paseo.agents.list({ sort: [{ key: 'updated_at', direction: 'desc' }], page: { limit: 100 } });
  for (const provider of ['claude', 'codex']) {
    let exported = false;
    for (const { agent } of page.entries) {
      if (agent.provider !== provider || agent.id === process.env.PASEO_AGENT_ID) continue;
      const { snapshot, entries } = await readSnapshot(paseo.agents.ref(agent.id).timeline.refetch as Refetch);
      if (!entries.some(e => e.item.type === 'user_message') || !entries.some(e => e.item.type === 'assistant_message')) continue;
      if (provider === 'claude' && !entries.some(e => e.item.type === 'tool_call' && typeof e.item.detail === 'object' && e.item.detail !== null
        && !Array.isArray(e.item.detail) && e.item.detail.type === 'sub_agent') && entries.filter(e => e.item.type === 'tool_call').length < 10) continue;
      const share = toShare({ id: agent.id, title: agent.title ?? '', provider, ...(agent.model ? { model: agent.model } : {}), cwd: agent.cwd,
        createdAt: agent.createdAt, updatedAt: agent.updatedAt, capturedAt: new Date().toISOString() }, snapshot, entries);
      const text = JSON.stringify(share);
      await writeFile(join(output, `${provider}.json`), text, { mode: 0o600 });
      process.stdout.write(JSON.stringify({ provider, entries: entries.length, bytes: Buffer.byteLength(text), localExport: `${provider}.json` }) + '\n');
      exported = true; break;
    }
    if (!exported) throw new Error(`No suitable ${provider} session found`);
  }
} finally { await paseo.dispose(); await client.close(); }
