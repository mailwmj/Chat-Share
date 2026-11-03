import { toShare } from '../shared/convert';
import type { SessionMetadata, TimelineEntry } from '../shared/format';

const previewPort = Number(process.env.PORT || 4173);
export const previewImageUrl = `http://127.0.0.1:${previewPort}/__preview/image.svg`;

export const session: SessionMetadata = {
  id: 'synthetic-session', title: 'Review the retry boundary', provider: 'claude', model: 'synthetic-model',
  cwd: '/synthetic/project', createdAt: '2026-11-03T09:00:00Z', updatedAt: '2026-11-03T09:05:00Z', capturedAt: '2026-11-03T09:06:00Z',
};
export const snapshot = { epoch: 'synthetic-epoch', window: { minSeq: 1, maxSeq: 12, nextSeq: 13 } };
export function entry(item: TimelineEntry['item'], seq = 1): TimelineEntry {
  return { provider: 'claude', timestamp: '2026-11-03T09:00:00Z', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], item };
}

export const attack = '<script>globalThis.__xssExecuted = true</script>\n<img src="x" onerror="globalThis.__xssExecuted=true">\n<a href="javascript:globalThis.__xssExecuted=true">click</a>\n[unsafe](javascript:alert(1))\n[encoded](javascript&#58;alert(1))\n[protocol](vbscript:alert(1))\n[fragment](#<script>alert(1)</script>)\n';

export function maliciousShare() {
  const items: TimelineEntry['item'][] = [
    { type: 'user_message', text: 'The request succeeds, but the client occasionally retries it. Find the boundary and make the retry safe. Keep the change small.' },
    { type: 'reasoning', text: 'First compare the request lifecycle with the retry policy. The important distinction is whether the server accepted the request before the connection closed.' },
    { type: 'tool_call', callId: 'read', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/synthetic/project/src/request.ts', content: 'export async function request() {\n  return send();\n}\n' } },
    { type: 'assistant_message', text: '## The retry starts too early\n\nThe client treats a closed connection as a rejected request. The server may already have accepted it.\n\nKeep the request identity stable across retries, and let the server recognize a repeated request.\n\n```ts\nconst requestId = crypto.randomUUID();\nawait send({ requestId, payload });\n```\n\nThis changes the retry boundary without changing the response format.' },
    { type: 'tool_call', callId: 'edit', name: 'Edit', status: 'completed', error: null, detail: { type: 'edit', filePath: '/synthetic/project/src/request.ts', oldString: 'return send(payload);\n', newString: 'const requestId = crypto.randomUUID();\nreturn retry(() => send({ requestId, payload }));\n' } },
    { type: 'tool_call', callId: 'shell', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'npm test -- request', cwd: '/synthetic/project', output: 'PASS request.test.ts\n  ✓ retries preserve the request identity\n  ✓ a new request has a new identity\n\n2 tests passed.' } },
    { type: 'assistant_message', text: `The focused checks pass. A retry now carries the same identity as the first attempt. A separate request receives a new one.\n\n![Local screenshot](file:///synthetic/screenshot.png)\n\n![External image](${previewImageUrl})` },
    { type: 'tool_call', callId: 'hostile', name: 'ExternalTool', status: 'completed', error: null, detail: { type: 'unknown', input: { fragment: '#<img src=x onerror=alert(1)>', fences: '```\n````\n~~~~' }, output: { html: attack, content: [{ type: 'text', text: attack }], giant: 'odd\u0000🧪'.repeat(12_000), constructor: 'literal-key' } }, agentMessage: { event: 'finished', sender: { id: 'synthetic-child' }, text: 'Synthetic return result.' } },
    { type: 'assistant_message', text: attack },
    { type: 'future_item<script>', payload: { text: attack, nested: [{ unknown: true }] } },
    { type: 'notification', level: 'info', message: 'The synthetic verification is complete.' },
    { type: 'plugin', id: 'synthetic-plugin-row', pluginId: 'synthetic-plugin', kind: 'Review summary', version: 1, data: { files: ['request.ts'], passed: 2 } },
  ];
  return toShare(session, snapshot, items.map((item, index) => entry(item, index + 1)));
}

export function designShare() {
  const longUserMessage = `我想给系统重构一下认证和授权中间件。目前我们发现了一个比较严重的问题：/api/billing 接口在每次收到请求时，token 校验逻辑实际上在全局路由守卫和具体的控制器方法内部各执行了一次，导致了重复计算和数据库查询开销。
请帮我把认证逻辑完整地收敛到统一的 requireAuth 中间件中。在重构过程中，请务必保证现有的自动化测试用例全部保持通过。
此外，请检查速率限制（Rate Limiting）的响应头配置，确保在 200 正常响应和 429 请求超限时都能正确返回 X-RateLimit-Limit 与 X-RateLimit-Remaining。
最后，在所有认证失败的地方生成审计日志，日志中必须记录客户端 IP、User Agent 以及时间戳，严禁泄漏 Authorization Bearer 令牌或用户密钥等敏感信息。`;

  const items: TimelineEntry['item'][] = [
    // Turn 1
    { type: 'user_message', text: '你好，请帮我检查并重构 auth 中间件，保持测试通过。' },
    { type: 'reasoning', text: '首先检查当前的路由守卫和中间件配置，查看 /api/billing 的 token 校验逻辑在哪里重复执行。' },
    { type: 'tool_call', callId: 'read-auth', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/src/middleware/auth.ts', content: 'export function verifyToken(req: Request) {\n  return check(req.headers.authorization);\n}\n' } },
    { type: 'tool_call', callId: 'search-billing', name: 'Search', status: 'completed', error: null, detail: { type: 'search', query: 'verifyToken /api/billing' } },
    { type: 'tool_call', callId: 'edit-auth', name: 'Edit', status: 'completed', error: null, detail: { type: 'edit', filePath: '/src/middleware/auth.ts', oldString: 'export function verifyToken(req: Request) {\n  return check(req.headers.authorization);\n}\n', newString: 'export function requireAuth(req: Request, res: Response, next: NextFunction) {\n  const token = req.headers.authorization?.replace(/^Bearer\\s+/, "");\n  if (!token) return res.status(401).json({ error: "missing_token" });\n  req.user = verifyTokenString(token);\n  next();\n}\n' } },
    { type: 'tool_call', callId: 'failed-shell', name: 'Bash', status: 'failed', error: 'Process exited with code 1: 1 test failed', detail: { type: 'shell', command: 'npm test -- --runInBand --testPathPattern="src/middleware/auth.test.ts" --coverage --coverageReporters="text" --coverageReporters="lcov" --detectOpenHandles --forceExit --verbose', cwd: '/src', output: 'FAIL tests/auth.test.ts\n  ✕ billing route checks auth twice (expected 1 call, received 2)\n\nTests: 1 failed, 1 total\nTime: 1.2s' } },
    { type: 'assistant_message', text: `我已经初步分析了认证中间件。第一次测试运行发现了重复调用的问题：

| Endpoint Route | Guard Type | Duplicate Check | HTTP Status | Rate Limit Header | Latency |
| :--- | :--- | :--- | :--- | :--- | :--- |
| \`/api/billing/v2/invoices/export\` | GlobalJwtGuard | InControllerVerification | \`401 Unauthorized\` | \`X-RateLimit-Remaining: 99\` | 18ms |
| \`/api/auth/token/refresh/session\` | PublicAccess | None (Bypassed) | \`200 OK\` | \`X-RateLimit-Remaining: 100\` | 4ms |
| \`/api/system/health/readiness\` | InternalOnly | None (Bypassed) | \`200 OK\` | \`X-RateLimit-Remaining: 100\` | 2ms |

Unbroken token identifier:
SupercalifragilisticexpialidociousUnbrokenLongStringThatMustNeverOverflowMobileScreenLayoutEvenAt320pxWidth

Audit reference URL:
https://auth.internal.service.example.org/api/v2/organizations/engineering/teams/core/audit-records/sync?filter_date_range_start=2026-11-01T00%3A00%3A00Z&filter_date_range_end=2026-11-03T23%3A59%3A59Z&include_details=true&format=compact_json

接下来我将移除 handler 内的重复调用并修复测试。` },

    // Turn 2: Very long user message + task updates + truncated output
    { type: 'user_message', text: longUserMessage },
    { type: 'todo', items: [{ id: '1', text: 'Move auth into requireAuth middleware', status: 'completed' }, { id: '2', text: 'Fix billing controller duplicate check', status: 'in_progress' }, { id: '3', text: 'Add rate limit headers test', status: 'pending' }] },
    { type: 'reasoning', text: 'Now removing the duplicate token verification inside the billing controller and re-running the test suite.' },
    { type: 'tool_call', callId: 'edit-billing', name: 'Edit', status: 'completed', error: null, detail: { type: 'edit', filePath: '/src/controllers/billing.ts', oldString: 'const user = verifyToken(req);\nconst bill = getBilling(user.id);\n', newString: 'const bill = getBilling(req.user.id, { includePendingInvoices: true, auditContext: { clientIp: req.ip, userAgent: req.headers["user-agent"], requestId: req.headers["x-request-id"], timestamp: new Date().toISOString() } });\n' } },
    { type: 'tool_call', callId: 'shell-success', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', command: 'npm test -- coverage', cwd: '/src', output: 'PASS tests/auth.test.ts\nPASS tests/billing.test.ts\nCoverage: 98% branches, 100% functions.\nAll 24 tests passed successfully.\n[Content truncated]' } },
    { type: 'assistant_message', text: `Done. Auth now lives in \`requireAuth\` and all 24 tests pass.

\`\`\`ts
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\\s+/, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  req.user = verifyToken(token);
  next();
}
\`\`\`

Here are the test architecture and local screenshot:

![External Architecture](${previewImageUrl})
![Local Screenshot](file:///tmp/auth-audit.png)` },

    // Turn 3: Single-step run, error row splitting runs, non-merged items
    { type: 'user_message', text: 'Please verify the subagent audit logs and plugin sync.' },
    // Single-step run:
    { type: 'tool_call', callId: 'single-fetch', name: 'Fetch', status: 'completed', error: null, detail: { type: 'fetch', url: 'https://api.internal/audit/ping' } },
    // Error row splitting two runs:
    { type: 'error', message: 'Connection to audit sync service timed out after 3000ms' },
    // Run after error row (multi-step):
    { type: 'reasoning', text: 'Audit service was slow to respond. Retrying via subagent.' },
    { type: 'tool_call', callId: 'subagent-audit', name: 'Subagent', status: 'completed', error: null, detail: { type: 'sub_agent', subAgentType: 'audit-sync', description: 'Re-sync audit log entries', log: 'Synced 14 log records successfully.' } },
    { type: 'tool_call', callId: 'write-report', name: 'Write', status: 'completed', error: null, detail: { type: 'write', filePath: '/tmp/audit-report.json', content: '{"synced": 14, "errors": 0}' } },
    // Non-merged items:
    { type: 'compaction', message: 'Context compacted: 12KB freed.' },
    { type: 'notification', level: 'info', message: 'Audit sync pipeline resumed successfully.' },
    { type: 'plugin', id: 'plugin-audit-watcher', pluginId: 'audit-watcher', kind: 'Audit Status', version: 1, data: { synced: 14, status: 'healthy' } },
    { type: 'future_item<custom>', payload: { customData: true, reason: 'Future extension test' } },
    { type: 'assistant_message', text: '所有审计日志已同步完成，包含全部非合并条目类型与重构验证。' },
  ];

  const share = toShare(
    { ...session, title: 'Auth middleware refactoring and audit sync', id: 'synthetic-design-session' },
    { ...snapshot, window: { minSeq: 1, maxSeq: items.length, nextSeq: items.length + 1 } },
    items.map((item, index) => entry(item, index + 1))
  );

  // Add truncation entry for shell-success (item index 10 in items, which corresponds to index 10 in entries)
  share.truncations.push({
    entry: 10,
    path: ['detail', 'output'],
    certainty: 'definite',
  });

  return share;
}

export function benchmarkShare() {
  const items: TimelineEntry['item'][] = [
    { type: 'user_message', text: 'Start 5000 step benchmark' },
  ];
  for (let i = 1; i <= 5000; i++) {
    if (i % 2 === 1) {
      items.push({ type: 'reasoning', text: `Reasoning step ${i}: verifying state and plan.` });
    } else {
      items.push({
        type: 'tool_call',
        callId: `call-${i}`,
        name: i % 4 === 0 ? 'Bash' : 'Edit',
        status: 'completed',
        error: null,
        detail: i % 4 === 0
          ? { type: 'shell', command: `npm test -- step=${i}`, output: `step ${i} passed\n` }
          : { type: 'edit', filePath: `/src/file-${i % 25}.ts`, oldString: `old line ${i}\n`, newString: `new line ${i}\n` },
      });
    }
  }
  items.push({ type: 'assistant_message', text: 'All 5000 steps executed successfully.' });
  return toShare(
    { ...session, id: 'benchmark-5000', title: '5,000 Step Benchmark Session' },
    { ...snapshot, window: { minSeq: 1, maxSeq: items.length, nextSeq: items.length + 1 } },
    items.map((item, index) => entry(item, index + 1))
  );
}
