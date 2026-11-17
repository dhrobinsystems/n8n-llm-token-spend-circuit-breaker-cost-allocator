#!/usr/bin/env node
/*
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-llm-token-spend-circuit-breaker-cost-allocator.
 *
 * Zero dependencies and zero network modules: only fs, path and vm are
 * required. Code-node JavaScript is taken verbatim from workflow.json and run
 * in isolated VM contexts by a small engine that follows workflow.json's
 * connections, evaluates IF / HTTP {{ expressions }} and emulates n8n workflow
 * static data and the Respond to Webhook node. HTTP nodes are routed to
 * in-memory OpenAI / Anthropic / Slack / Teams mocks that check auth headers
 * and request shapes, and return real response shapes (usage blocks, 429,
 * 529, quota errors, timeouts).
 *
 * Verifies: structure and static safety, safe defaults, config and money /
 * price validation, webhook auth, fixture parity and synthetic data, pricing
 * and exact integer cost arithmetic, worst-case estimation, every fixture
 * scenario (low spend, soft-cap downgrade, hard-cap trip, provider failures,
 * breaker transitions, unpriced models, redaction, rejection), deterministic
 * fallback rules, exact cost-center allocation, ledger validation, rollover
 * and fail-closed corruption handling, monitor-only mode, live calls against
 * the mocks, persistence, alert dedupe and Slack / Teams payloads.
 *
 * Usage:  node scripts/simulate-sandbox-run.js [--quiet]
 * Exit:   0 when every check passes, 1 otherwise.
 * Output: sim-output/ (git-ignored): gateway response, alert previews, report.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

globalThis.fetch = () => { throw new Error('Network access is not allowed in the simulator'); };

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const FIXTURE_PATH = path.join(ROOT, 'sample-payloads', 'token-usage-fixture.json');
const OUT_DIR = path.join(ROOT, 'sim-output');
const QUIET = process.argv.includes('--quiet');
const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; if (!QUIET) console.log(`  ✔ ${label}`); }
  else { failed++; failures.push(label + (detail ? ` -- ${detail}` : '')); console.log(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => { if (!QUIET) console.log(`\n▶ ${t}`); };

// ===================================================================== mocks
const TOKENS = {
  OPENAI_API_KEY: 'sim-placeholder-openai-key-0000',
  ANTHROPIC_API_KEY: 'sim-placeholder-anthropic-key-0000',
  WEBHOOK_SHARED_SECRET: 'sim-placeholder-webhook-secret-0123456789',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/TSIM00000/BSIM00000/simplaceholdersecretvalue',
  TEAMS_WEBHOOK_URL: 'https://prod-00.simregion.logic.azure.com/workflows/simplaceholder/triggers/manual/paths/invoke?sig=simplaceholdersig',
};
class HttpError extends Error { constructor(status, message) { super(`${status} - ${message}`); this.status = status; } }
// opts.llm(provider, body, n) may return { status, body, headers } or 'timeout'.
function makeMocks(opts = {}) {
  const state = { calls: [], posts: [], llm: [] };
  const full = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body });
  function llmReply(provider, body) {
    const n = state.llm.length;
    state.llm.push({ provider, body: clone(body) });
    const custom = opts.llm ? opts.llm(provider, body, n) : null;
    if (custom === 'timeout') throw new Error('timeout of 30000ms exceeded');
    if (custom) return full(custom.status || 200, custom.body, custom.headers);
    const text = body.messages.map((m) => m.content).join(' ');
    const promptTok = Math.ceil(text.length / 4) + 8;
    const outTok = Math.min(20, provider === 'anthropic' ? body.max_tokens : body.max_completion_tokens);
    if (provider === 'anthropic') return full(200, { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'mock reply' }], stop_reason: 'end_turn', usage: { input_tokens: promptTok, output_tokens: outTok, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    return full(200, { id: 'chatcmpl-mock', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'mock reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: promptTok, completion_tokens: outTok, total_tokens: promptTok + outTok, prompt_tokens_details: { cached_tokens: 0 } } });
  }
  function handle({ method, url, headers, body, node }) {
    const u = new URL(url);
    state.calls.push({ node, method, host: u.host, path: u.pathname, headers: clone(headers), body: clone(body) });
    if (u.host === 'api.openai.com') {
      if (u.pathname !== '/v1/chat/completions' || method !== 'POST') return full(404, { error: { message: 'unknown route' } });
      if (headers.Authorization !== `Bearer ${TOKENS.OPENAI_API_KEY}`) return full(401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
      if (headers['x-api-key']) return full(400, { error: { message: 'mock: anthropic key leaked to openai' } });
      if (!body.model || !Array.isArray(body.messages) || !Number.isInteger(body.max_completion_tokens)) return full(400, { error: { message: 'invalid body' } });
      return llmReply('openai', body);
    }
    if (u.host === 'api.anthropic.com') {
      if (u.pathname !== '/v1/messages' || method !== 'POST') return full(404, { type: 'error', error: { type: 'not_found_error', message: 'unknown route' } });
      if (headers['x-api-key'] !== TOKENS.ANTHROPIC_API_KEY || headers['anthropic-version'] !== '2023-06-01') return full(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (headers.Authorization) return full(400, { type: 'error', error: { type: 'invalid_request_error', message: 'mock: openai key leaked to anthropic' } });
      if (!body.model || !Array.isArray(body.messages) || !Number.isInteger(body.max_tokens)) return full(400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid body' } });
      return llmReply('anthropic', body);
    }
    if (u.host === 'hooks.slack.com') {
      if (opts.failSlack) throw new HttpError(404, 'no_service');
      if (url !== TOKENS.SLACK_WEBHOOK_URL) throw new HttpError(403, 'wrong slack webhook');
      state.posts.push({ channel: 'slack', body: clone(body) });
      return { data: 'ok' };
    }
    if (u.host.endsWith('.logic.azure.com')) {
      if (url !== TOKENS.TEAMS_WEBHOOK_URL) throw new HttpError(401, 'bad sig');
      if (!body || body.type !== 'message' || body.attachments[0].contentType !== 'application/vnd.microsoft.card.adaptive') throw new HttpError(400, 'Workflows expects an Adaptive Card message');
      state.posts.push({ channel: 'teams', body: clone(body) });
      return {};
    }
    throw new HttpError(502, 'unmocked host ' + u.host);
  }
  return { state, handle };
}
// ==================================================================== engine
function evalExpr(template, ctx) {
  if (typeof template !== 'string' || !template.startsWith('=')) return template;
  const t = template.slice(1);
  const run = (expr) => vm.runInNewContext(`(${expr})`, { ...ctx, encodeURIComponent, JSON, String, Object, Number }, { timeout: 2000 });
  const single = t.match(/^\{\{([\s\S]*)\}\}$/);
  if (single && !single[1].includes('}}')) return run(single[1]);
  return t.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const v = run(e); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
}
function runWorkflow({ trigger = 'manual', webhookItem, env = {}, mocks, staticData = {} }) {
  const runData = {};
  let webhookResponse = null;
  const envProxy = new Proxy({}, { get(_t, k) { if (env === 'BLOCKED') throw new Error('access to env vars denied'); return typeof k === 'string' ? env[k] : undefined; } });
  const accessor = (name) => {
    const runs = runData[name];
    if (!runs || !runs.length) throw new Error(`Referenced node "${name}" has not executed`);
    const items = (runs[runs.length - 1][0] || []).map(clone);
    return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
  };
  const ctxFor = (item) => ({ $json: clone(item.json), $: accessor, $env: envProxy });
  function exec(name, items) {
    const node = byName[name];
    let outputs;
    switch (node.type) {
      case 'n8n-nodes-base.manualTrigger': case 'n8n-nodes-base.webhook': case 'n8n-nodes-base.scheduleTrigger':
        outputs = [items]; break;
      case 'n8n-nodes-base.respondToWebhook':
        webhookResponse = { statusCode: node.parameters.options.responseCode || 200, body: JSON.parse(evalExpr(node.parameters.responseBody, ctxFor(items[0]))) };
        outputs = [items]; break;
      case 'n8n-nodes-base.code': {
        const sandbox = {
          $input: { first: () => clone(items[0]), all: () => items.map(clone), item: clone(items[0]) },
          $env: envProxy, $: accessor, $getWorkflowStaticData: () => staticData,
          require: (m) => { throw new Error(`Cannot find module '${m}'`); },
          console: { log() {}, warn() {}, error() {} },
        };
        const res = vm.runInNewContext(`(() => {\n${node.parameters.jsCode}\n})()`, sandbox, { timeout: 20000, filename: `${name}.js` });
        if (!Array.isArray(res)) throw new Error(`Code node "${name}" did not return an array`);
        outputs = [res.map((i) => clone({ json: i.json }))];
        break;
      }
      case 'n8n-nodes-base.if': {
        const t = [], f = [];
        for (const it of items) (evalExpr(node.parameters.conditions.conditions[0].leftValue, ctxFor(it)) === true ? t : f).push(it);
        outputs = [t, f]; break;
      }
      case 'n8n-nodes-base.httpRequest': {
        const out = [];
        const pg = node.parameters.options && node.parameters.options.pagination && node.parameters.options.pagination.pagination;
        for (const it of items) {
          const c = ctxFor(it);
          let url = evalExpr(node.parameters.url, c);
          const headers = Object.fromEntries((node.parameters.headerParameters?.parameters || []).map((h) => [h.name, evalExpr(h.value, c)]));
          let body = node.parameters.sendBody ? JSON.parse(evalExpr(node.parameters.jsonBody, c)) : undefined;
          const send = () => mocks.handle({ method: node.parameters.method || 'GET', url, headers, body, node: name });
          try {
            if (!pg) { out.push({ json: send() }); continue; }
            for (let n = 0; n < pg.maxRequests; n++) {
              const resp = send();
              out.push({ json: resp });
              const rc = { ...c, $response: { body: resp } };
              if (evalExpr(pg.completeExpression, rc) === true) break;
              for (const prm of pg.parameters.parameters) {
                const v = evalExpr(prm.value, rc);
                if (prm.type === 'body') body = { ...body, [prm.name]: v };
                if (prm.type === 'qs') { const uu = new URL(url); uu.searchParams.set(prm.name, v); url = uu.toString(); }
              }
            }
          } catch (e) {
            if (node.onError === 'continueRegularOutput') out.push({ json: { error: { message: e.message, status: e.status } } });
            else throw Object.assign(new Error(`${name}: ${e.message}`), { node: name });
          }
        }
        outputs = [out]; break;
      }
      default: throw new Error(`Engine does not support ${node.type}`);
    }
    (runData[name] = runData[name] || []).push(outputs.map((o) => (o || []).map(clone)));
    const conns = (workflow.connections[name] || {}).main || [];
    outputs.forEach((o, idx) => { if (o && o.length) for (const cn of conns[idx] || []) exec(cn.node, o); });
  }
  let error = null;
  try {
    if (trigger === 'webhook') exec('LLM Gateway Webhook', [{ json: webhookItem }]);
    else if (trigger === 'schedule') exec('Daily Spend Digest (23:47)', [{ json: { timestamp: '2026-11-17T23:47:00.000+00:00', 'Day of week': 'Tuesday' } }]);
    else exec('Manual Test Trigger', [{ json: {} }]);
  } catch (e) { error = e; }
  const last = (n) => (runData[n] ? runData[n][runData[n].length - 1][0].map((i) => i.json) : undefined);
  return { runData, error, last, mocks, staticData, webhookResponse };
}


// ============================================================== helpers
const NOW = '2026-11-17T14:00:00.000Z';
const LIVE = { SANDBOX_MODE: 'false', NOW_OVERRIDE: NOW, WEBHOOK_SHARED_SECRET: TOKENS.WEBHOOK_SHARED_SECRET };
const ARMED = { ...LIVE, DRY_RUN: 'false', LLM_CALLS_ENABLED: 'true', OPENAI_API_KEY: TOKENS.OPENAI_API_KEY, ANTHROPIC_API_KEY: TOKENS.ANTHROPIC_API_KEY };
const ALERTS = { ALERTS_ENABLED: 'true', ALERT_CHANNELS: 'slack,teams', SLACK_WEBHOOK_URL: TOKENS.SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL: TOKENS.TEAMS_WEBHOOK_URL };
const SB = (extra = {}, opts = {}) => runWorkflow({ env: { NOW_OVERRIDE: NOW, ...extra }, mocks: makeMocks(opts.mocks), staticData: opts.sd || {} });
const cfgOf = (env) => { const r = runWorkflow({ env, mocks: makeMocks() }); return { r, c: r.last('Config & Safety Gate') && r.last('Config & Safety Gate')[0].config }; };
const respOf = (r) => r.last('Gateway Response')[0].response;
const resOf = (r, id) => respOf(r).results.find((x) => x.request_id === id);
const decOf = (r, id) => r.last('Circuit Breaker & Router')[0].decisions.find((d) => d.requestId === id);
const reportOf = (r) => r.last('Gateway Run Report')[0];
const hook = (body, secret = TOKENS.WEBHOOK_SHARED_SECRET) => ({ headers: secret ? { 'x-gateway-secret': secret } : {}, query: {}, body });
const REQ = (o = {}) => ({ request_id: 'wh-001', task: 'classify', provider: 'openai', model: 'gpt-5-mini', input: 'The export page shows an error.', client_key: 'client_test', workflow_id: 'wf_test', cost_center: 'cc-support', max_output_tokens: 16, ...o });
const nanos = (usd) => Math.round(usd * 1e9);
function seedLedger(mut) {
  const l = clone(fixture.ledgerSeed);
  if (mut) mut(l);
  return l;
}
function validateSlack(p) {
  const e = [];
  if (!p.text || !Array.isArray(p.blocks) || p.blocks.length > 50) e.push('text/blocks');
  for (const [i, b] of p.blocks.entries()) {
    if (b.type === 'header' && b.text.text.length > 150) e.push(`#${i} header`);
    if (b.type === 'section' && b.text && b.text.text.length > 3000) e.push(`#${i} text`);
    if (b.type === 'section' && b.fields && (b.fields.length > 10 || b.fields.some((f) => f.text.length > 2000))) e.push(`#${i} fields`);
    if (b.type === 'context' && b.elements.some((x) => x.text.length > 3000)) e.push(`#${i} context`);
  }
  return e;
}

// ====================================================================== main
(function main() {
  console.log('n8n-llm-token-spend-circuit-breaker-cost-allocator :: offline simulator');
  console.log(`workflow: workflow.json (${workflow.nodes.length} nodes)`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ----------------------------------------------------------- 1. structure
  section('1. Workflow structure and static safety checks');
  const names = workflow.nodes.map((n) => n.name);
  check('Node names are unique', new Set(names).size === names.length);
  check('Workflow is inactive on import', workflow.active === false);
  const bad = [];
  for (const [s, c] of Object.entries(workflow.connections)) { if (!byName[s]) bad.push(s); for (const b of c.main || []) for (const x of b) if (!byName[x.node]) bad.push(`${s}->${x.node}`); }
  check('All connections reference existing nodes', bad.length === 0, bad.join(', '));
  const ifs = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.if');
  check(`All ${ifs.length} IF nodes wire both outputs`, ifs.every((n) => (workflow.connections[n.name]?.main || []).length === 2 && workflow.connections[n.name].main.every((b) => b.length)));
  const reach = new Set();
  const walk = (n) => { if (reach.has(n)) return; reach.add(n); for (const b of workflow.connections[n]?.main || []) for (const c of b) walk(c.node); };
  ['Manual Test Trigger', 'LLM Gateway Webhook', 'Daily Spend Digest (23:47)'].forEach(walk);
  const unreach = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !reach.has(n.name)).map((n) => n.name);
  check('Every functional node is reachable from a trigger', unreach.length === 0, unreach.join(', '));
  const wh = byName['LLM Gateway Webhook'];
  check('Gateway webhook is POST and answers through "Respond to Webhook"', wh.parameters.httpMethod === 'POST' && wh.parameters.responseMode === 'responseNode' && byName['Respond to Webhook'].type === 'n8n-nodes-base.respondToWebhook');
  const llm = byName['Call LLM Provider'];
  const h = Object.fromEntries(llm.parameters.headerParameters.parameters.map((x) => [x.name, x.value]));
  check('OpenAI key only via {{ $env.OPENAI_API_KEY }}, Anthropic key only via {{ $env.ANTHROPIC_API_KEY }}', h.Authorization.includes("'Bearer ' + $env.OPENAI_API_KEY") && h['x-api-key'].includes('$env.ANTHROPIC_API_KEY') && h['anthropic-version'].includes('2023-06-01'));
  check('Each key is sent only to its own provider (header gated on provider)', /\$json\.provider === 'openai'/.test(h.Authorization) && /\$json\.provider === 'anthropic'/.test(h['x-api-key']));
  check('LLM HTTP node: full response + never error, continue on fail, NO auto-retry, timeout from config', llm.parameters.options.response.response.fullResponse && llm.parameters.options.response.response.neverError && llm.onError === 'continueRegularOutput' && !llm.retryOnFail && /llm\.timeoutMs/.test(llm.parameters.options.timeout));
  const post = byName['Post Slack / Teams Alert'];
  check('Alert URL comes only from $env; no auto-retry', post.parameters.url === "={{ $json.channel === 'teams' ? $env.TEAMS_WEBHOOK_URL : $env.SLACK_WEBHOOK_URL }}" && !post.retryOnFail);
  check('No stored n8n credentials', workflow.nodes.every((n) => !n.credentials));
  const codeSrc = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => [n.name, n.parameters.jsCode]);
  check('Only Commit Spend Ledger and Alert Result write static data', codeSrc.filter(([, s]) => /sd\.llmLedger\s*=(?!=)|sd\.llmLedger\.alertsSent\[/.test(s)).map(([n]) => n).sort().join() === 'Alert Result,Commit Spend Ledger');
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const PAT = [[/sk-(proj-)?[A-Za-z0-9_-]{20,}/, 'OpenAI key'], [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic key'], [/xox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'], [/hooks\.slack\.com\/services\/T[A-Z0-9]+\//, 'Slack webhook URL'], [/logic\.azure\.com\/workflows\//, 'Teams workflow URL'], [/sig=[A-Za-z0-9%_-]{20,}/, 'signed URL'], [/Bearer [A-Za-z0-9\-_.]{16,}/, 'literal bearer'], [/\b(?!555)\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/, 'phone number (non-555)']];
  const texts = { 'workflow.json': raw };
  for (const f of ['README.md', 'DISCLAIMER.md', '.env.example', 'sample-payloads/token-usage-fixture.json']) if (fs.existsSync(path.join(ROOT, f))) texts[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const hits = [];
  for (const [f, t] of Object.entries(texts)) for (const [re, l] of PAT) if (re.test(t)) hits.push(`${l} in ${f}`);
  check('No API keys, webhook URLs, signed URLs or real-looking phone numbers in shipped files', hits.length === 0, hits.join(', '));
  const emails = [...new Set((raw + texts['sample-payloads/token-usage-fixture.json']).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
  check('Every email in workflow / fixture uses example.com', emails.length > 0 && emails.every((e) => /@example\.com$/i.test(e)), emails.join(','));
  const exprErr = [];
  const visit = (v, w) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { try { new Function('$json', '$', '$env', '$response', `return (${m[1]});`); } catch (e) { exprErr.push(`${w}: ${e.message}`); } } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${w}.${k}`); };
  workflow.nodes.forEach((n) => visit(n.parameters, n.name));
  check('Every {{ expression }} parses as JavaScript', exprErr.length === 0, exprErr.join('; '));
  const cErr = [];
  for (const [n, s] of codeSrc) { try { new vm.Script(`(() => {\n${s}\n})`); } catch (e) { cErr.push(`${n}: ${e.message}`); } }
  check('Every Code node compiles', cErr.length === 0, cErr.join('; '));
  check('Code nodes call no require() (no network, fs or crypto modules)', codeSrc.every(([, s]) => !/\brequire\s*\(/.test(s)));
  check('No Code node reads an API key or webhook URL from $env except via the Config "is set" checks', codeSrc.filter(([n]) => n !== 'Config & Safety Gate').every(([, s]) => !/\$env/.test(s.replace(/\/\/.*$/gm, ''))));

  // ------------------------------------------------------ 2. config
  section('2. Safe defaults and config validation');
  const { c: d0 } = cfgOf({ NOW_OVERRIDE: NOW });
  check('Empty env -> SANDBOX, DRY_RUN, breaker enforcing, LLM calls + alerts blocked, no persistence', d0.sandboxMode && d0.dryRun && d0.breaker.active && !d0.llm.liveCallsAllowed && !d0.alerts.allowedByConfig && !d0.ledger.persist);
  check('Default budgets: $5.00 hard, soft 80%, $0.25 per request, 5% safety margin, downgrade at soft cap', d0.budgets.global.hardNanos === 5e9 && d0.budgets.global.softPct === 80 && d0.budgets.perRequestMaxNanos === 2.5e8 && d0.budgets.safetyMarginPct === 5 && d0.budgets.softCapAction === 'downgrade');
  check('Attribution required and PII redaction on by default', d0.privacy.requireAttribution && d0.privacy.redactPii);
  const { c: typo } = cfgOf({ NOW_OVERRIDE: NOW, SANDBOX_MODE: 'flase', DRY_RUN: 'nah', LLM_CALLS_ENABLED: 'please', CIRCUIT_BREAKER_ACTIVE_BY_DEFAULT: 'nope' });
  check('Typos keep SANDBOX / DRY_RUN / breaker on and do not arm LLM calls', typo.sandboxMode && typo.dryRun && typo.breaker.active && !typo.llm.callsEnabled);
  const { c: blk } = cfgOf('BLOCKED');
  check('Blocked $env -> sandbox, calls blocked, no persistence', blk.envBlocked && blk.sandboxMode && !blk.llm.liveCallsAllowed && !blk.ledger.persist);
  const { c: m1 } = cfgOf({ NOW_OVERRIDE: NOW, DAILY_HARD_CAP_USD: '12.345678901' });
  check('Money parser: "12.345678901" USD = 12345678901 nano-USD exactly (no float drift)', m1.budgets.global.hardNanos === 12345678901);
  const { c: m2 } = cfgOf({ NOW_OVERRIDE: NOW, DAILY_HARD_CAP_USD: '-5', PER_REQUEST_MAX_USD: '1e3', COST_CURRENCY: 'EUR' });
  check('Negative / scientific amounts and non-USD currency are config errors', m2.configErrors.some((e) => /DAILY_HARD_CAP_USD/.test(e)) && m2.configErrors.some((e) => /PER_REQUEST_MAX_USD/.test(e)) && m2.configErrors.some((e) => /COST_CURRENCY/.test(e)));
  check('Default pricing: gpt-5.4-mini = 0.75 / 0.075 / 4.50 USD per MTok as micro-USD integers', JSON.stringify([d0.pricing['gpt-5.4-mini'].input, d0.pricing['gpt-5.4-mini'].cachedInput, d0.pricing['gpt-5.4-mini'].output]) === '[750000,75000,4500000]');
  check('Default pricing: claude-haiku-5-5 long-context tier above 100K prompt tokens', d0.pricing['claude-haiku-5-5'].long.aboveInputTokens === 100000 && d0.pricing['claude-haiku-5-5'].long.input === 500000);
  const { c: p1 } = cfgOf({ NOW_OVERRIDE: NOW, MODEL_PRICING_JSON: JSON.stringify({ 'gpt-5-nano': { provider: 'openai', input: '0.0000001', output: '0.4' }, 'x-model': { provider: 'acme', input: '1', output: '2' } }) });
  check('MODEL_PRICING_JSON: > 6 decimals and unknown provider are rejected', p1.configErrors.some((e) => /gpt-5-nano.input/.test(e)) && p1.configErrors.some((e) => /x-model.provider/.test(e)));
  const { c: p2 } = cfgOf({ NOW_OVERRIDE: '2027-06-01T00:00:00.000Z' });
  check('Pricing table older than PRICING_MAX_AGE_DAYS raises a warning', p2.warnings.some((w) => /Pricing table is \d+ days old/.test(w)));
  const { c: dg } = cfgOf({ NOW_OVERRIDE: NOW, DOWNGRADE_MAP_JSON: JSON.stringify({ 'gpt-5-nano': 'gpt-5.5', 'gpt-5.5': 'claude-haiku-5-5' }) });
  check('Downgrade map refuses "downgrades" that cost more or cross providers', dg.configErrors.some((e) => /not cheaper/.test(e)) && dg.configErrors.some((e) => /crosses providers/.test(e)));
  const { c: rx } = cfgOf({ NOW_OVERRIDE: NOW, FALLBACK_CLASSIFY_RULES_JSON: JSON.stringify([{ label: 'evil', pattern: '(a+)+$' }, { label: 'ok', pattern: 'refund' }]) });
  check('Fallback regex with nested quantifiers (ReDoS) is rejected', rx.configErrors.some((e) => /nested quantifiers/.test(e)) && rx.fallback.classifyRules.length === 1);
  const { c: host } = cfgOf({ NOW_OVERRIDE: NOW, OPENAI_API_BASE_URL: 'https://api.openai.com.attacker.example', ANTHROPIC_API_BASE_URL: 'https://user:pass@api.anthropic.com' });
  check('Provider base URLs: non-allowlisted host and embedded credentials are refused', !host.llm.providers.openai.endpointValid && !host.llm.providers.anthropic.endpointValid && host.configErrors.length >= 2);
  const al = (env) => cfgOf({ ...ARMED, ...ALERTS, ...env }).c.alerts;
  check('Slack URL on a non-allowlisted host is refused', !al({ ALERT_CHANNELS: 'slack', SLACK_WEBHOOK_URL: 'https://hooks.slack.com.attacker.example/x' }).allowedByConfig);
  check('Teams URL over plain http is refused', al({ ALERT_CHANNELS: 'teams', TEAMS_WEBHOOK_URL: 'http://prod-00.simregion.logic.azure.com/x' }).blockers.some((b) => /https/.test(b)));
  const { r: secretRun } = cfgOf({ ...ARMED, ...ALERTS });
  check('Config output contains no API key or webhook URL (only "is set" booleans)', Object.values(TOKENS).every((s) => !JSON.stringify(secretRun.runData['Config & Safety Gate']).includes(s)) && secretRun.last('Config & Safety Gate')[0].config.llm.providers.openai.keySet === true);
  const { c: mon } = cfgOf({ NOW_OVERRIDE: NOW, CIRCUIT_BREAKER_ACTIVE_BY_DEFAULT: 'false' });
  check('Disabling the breaker is explicit and loudly warned (MONITOR-ONLY)', !mon.breaker.active && mon.warnings.some((w) => /MONITOR-ONLY/.test(w)));
  const { c: day } = cfgOf({ NOW_OVERRIDE: '2026-11-17T20:30:00.000Z', BUDGET_UTC_OFFSET_MINUTES: '360' });
  check('Budget day honours BUDGET_UTC_OFFSET_MINUTES (20:30Z at UTC+6 is 2026-11-18)', day.budgetDay === '2026-11-18' && day.dayStartMs === Date.UTC(2026, 10, 17, 18));

  // ----------------------------------------------------- 3. webhook
  section('3. Webhook authentication and request validation');
  const w1 = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }, null), env: ARMED, mocks: makeMocks() });
  check('Live webhook without secret is rejected before any provider call', w1.error && /Gateway webhook rejected/.test(w1.error.message) && w1.mocks.state.calls.length === 0);
  const w2m = makeMocks();
  const w2 = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: ARMED, mocks: w2m, staticData: {} });
  check('Valid webhook: one live OpenAI call, JSON response returned to the caller', !w2.error && w2m.state.llm.length === 1 && w2.webhookResponse && w2.webhookResponse.body.results[0].status === 'LLM_OK', w2.error && w2.error.message);
  check('Webhook response carries cost, usage and attribution but no prompt text', w2.webhookResponse.body.results[0].cost_usd !== '0.000000000' && !JSON.stringify(w2.webhookResponse.body).includes('export page shows'));
  check('Secret never copied past the trigger node', Object.entries(w2.runData).filter(([n]) => n !== 'LLM Gateway Webhook').every(([, v]) => !JSON.stringify(v).includes(TOKENS.WEBHOOK_SHARED_SECRET)));
  const many = Array.from({ length: 26 }, (_, i) => REQ({ request_id: `wh-${i}` }));
  const w3 = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: many }), env: ARMED, mocks: makeMocks() });
  check('Batch larger than MAX_REQUESTS_PER_RUN is refused as a whole', w3.error && /MAX_REQUESTS_PER_RUN/.test(w3.error.message));
  const w4m = makeMocks();
  const w4 = runWorkflow({ trigger: 'webhook', webhookItem: hook(REQ({ max_output_tokens: 99999, request_id: 'single' })), env: ARMED, mocks: w4m, staticData: {} });
  check('Single-object body accepted; max_output_tokens clamped to MAX_OUTPUT_TOKENS_CAP', !w4.error && w4m.state.llm[0].body.max_completion_tokens === 2048 && resOf(w4, 'single').flags.includes('MAX_OUTPUT_CLAMPED'));
  const w5 = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ({ provider: 'anthropic', model: 'gpt-5-mini' })] }), env: ARMED, mocks: makeMocks(), staticData: {} });
  check('Provider / model mismatch is REJECTED (never sent)', resOf(w5, 'wh-001').status === 'REJECTED' && resOf(w5, 'wh-001').fallback.reason === 'PROVIDER_MODEL_MISMATCH' && w5.mocks.state.llm.length === 0);

  // ---------------------------------------------------- 4. fixture
  section('4. Fixture parity and synthetic data');
  const emb = byName['Request Intake & Validation'].parameters.jsCode.match(/const FIXTURE = ([\s\S]*?);\n\nconst KEY_RE/);
  let parity = false;
  try { parity = JSON.stringify(JSON.parse(emb[1])) === JSON.stringify(fixture); } catch (e) { parity = false; }
  check('Fixture embedded in workflow.json equals sample-payloads/token-usage-fixture.json', parity);
  check('Fixture flagged synthetic; every client / workflow / campaign key is a placeholder', fixture._meta.synthetic && fixture.requests.every((r) => !r.client_key || /^client_(alpha|beta|gamma|delta)$/.test(r.client_key)));
  const seedSum = Object.values(fixture.ledgerSeed.spentNanos.clients).reduce((a, b) => a + b, 0);
  check('Fixture ledger seed is internally consistent (clients sum to global)', seedSum === fixture.ledgerSeed.spentNanos.global);
  check('Fixture covers low spend, soft cap, hard-cap trip and fallback engagement', ['Low spend', 'soft cap', 'hard cap trip', '429', 'timeout', 'insufficient_quota'].every((k) => Object.values(fixture._meta.scenarios).join(' ').includes(k)));

  // ------------------------------------------- 5. pricing + arithmetic
  section('5. Pricing lookup, estimation and exact cost arithmetic');
  const rsrc = byName['Circuit Breaker & Router'].parameters.jsCode;
  const grab = (src, name) => { const s = src.indexOf(`function ${name}(`); let depth = 0; for (let i = src.indexOf('{', s); i < src.length; i++) { if (src[i] === '{') depth++; if (src[i] === '}' && --depth === 0) return src.slice(s, i + 1); } return ''; };
  const ctx = {};
  vm.runInNewContext(`const config = ${JSON.stringify(d0)}; const E = config.estimation;\n${grab(rsrc, 'resolvePrice')}\n${grab(rsrc, 'allocate')}\nconst inputTokensEst = (chars) => Math.ceil(chars / E.charsPerToken) + E.overheadTokens;\n${grab(rsrc, 'estimateNanos')}\nthis.rp = resolvePrice; this.al = allocate; this.est = estimateNanos; this.ite = inputTokensEst;`, ctx);
  check('Exact model id resolves; dated snapshot resolves to its base model', ctx.rp('gpt-5.4').key === 'gpt-5.4' && ctx.rp('gpt-5.4-2026-03-05').key === 'gpt-5.4' && ctx.rp('claude-haiku-4-5-20251001').key === 'claude-haiku-4-5');
  check('Prefix collisions do not mis-price (gpt-5.4-mini is not gpt-5.4; gpt-5.4-ultra is unpriced)', ctx.rp('gpt-5.4-mini').key === 'gpt-5.4-mini' && ctx.rp('gpt-5.4-ultra') === null);
  check('Estimate is worst case: ceil(chars / 3) + 16 input tokens and the full max output', ctx.ite(300) === 116 && ctx.est(ctx.rp('gpt-5.5'), 116, 2048) === Math.ceil((116 * 5000000 + 2048 * 30000000) / 1000));
  check('Long-context rate applies above 272K input tokens (gpt-5.4)', ctx.est(ctx.rp('gpt-5.4'), 300000, 0) === 300000 * 5000);
  const sp = ctx.al(1000000001, { 'cc-marketing': 60, 'cc-sales': 40 });
  check('Allocation is exact: 1000000001 nano split 60/40 -> 600000001 + 400000000 (sums to total)', sp['cc-marketing'] + sp['cc-sales'] === 1000000001 && sp['cc-marketing'] === 600000001);
  const sp3 = ctx.al(100, { a: 1, b: 1, c: 1 });
  check('Three-way equal split of 100 nano: 34 / 33 / 33 (largest remainder, deterministic)', sp3.a === 34 && sp3.b === 33 && sp3.c === 33);
  let fuzzOk = true;
  for (let i = 0; i < 2000; i++) { const n = (i * 7919 + 13) % 99991; const w = { x: 1 + (i % 7), y: 1 + (i % 11), z: 1 + (i % 5) }; const s = ctx.al(n, w); if (s.x + s.y + s.z !== n || Object.values(s).some((v) => v < 0)) fuzzOk = false; }
  check('Allocation fuzz: 2000 random splits always sum exactly and never go negative', fuzzOk);

  // ------------------------------------------------- 6. sandbox e2e
  section('6. Sandbox end-to-end: every fixture scenario');
  const sb = SB();
  check('Sandbox run completes', !sb.error, sb.error && sb.error.message);
  check('Sandbox run makes ZERO HTTP calls (responses simulated, nothing posted)', sb.mocks.state.calls.length === 0);
  const expected = {
    'req-001': ['LLM_OK', null], 'req-002': ['LLM_OK', null], 'req-003': ['LLM_DOWNGRADED', null], 'req-004': ['FALLBACK', 'HARD_CAP_CLIENT'],
    'req-005': ['FALLBACK', 'RATE_LIMITED'], 'req-006': ['FALLBACK', 'LLM_TIMEOUT'], 'req-007': ['LLM_OK', null], 'req-008': ['LLM_OK', null],
    'req-009': ['LLM_OK', null], 'req-010': ['FALLBACK', 'UNPRICED_MODEL'], 'req-011': ['FALLBACK', 'INPUT_TOO_LARGE'], 'req-012': ['REJECTED', 'MISSING_ATTRIBUTION'],
    'req-013': ['REJECTED', 'UNSUPPORTED_TASK'], 'req-014': ['LLM_DOWNGRADED', null], 'req-015': ['LLM_OK', null], 'req-016': ['FALLBACK', 'PROVIDER_BUDGET_EXCEEDED'],
    'req-017': ['FALLBACK', 'PROVIDER_OVERLOADED'], 'req-018': ['FALLBACK', 'RATE_LIMITED'], 'req-019': ['FALLBACK', 'LLM_TIMEOUT'], 'req-020': ['FALLBACK', 'HARD_CAP_GLOBAL'],
    'req-021': ['FALLBACK', 'HARD_CAP_TRIPPED'],
  };
  const got = Object.fromEntries(respOf(sb).results.map((r) => [r.request_id, [r.status, r.fallback ? r.fallback.reason : null]]));
  check('All 21 requests have the expected status and fallback reason', JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(Object.entries(got).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(expected[k]))));
  check('req-001 cost: 182 x $0.05 + 3 x $0.40 per MTok = $0.0000103 exactly', resOf(sb, 'req-001').cost_usd === '0.000010300');
  check('req-002 Anthropic cache read at cache-hit rate: 410 x 0.10 + 1800 x 0.01 + 96 x 0.50 = $0.000107', resOf(sb, 'req-002').cost_usd === '0.000107000' && resOf(sb, 'req-002').usage.cachedTokens === 1800);
  check('req-003 soft cap: claude-sonnet-5-5 -> claude-haiku-5-5, output clamped to 256', resOf(sb, 'req-003').downgraded_from === 'claude-sonnet-5-5' && resOf(sb, 'req-003').model_used === 'claude-haiku-5-5' && decOf(sb, 'req-003').maxOutput === 256 && resOf(sb, 'req-003').output.score === 72);
  check('req-004 hard cap: client_beta tripped, template reply carries the request id', resOf(sb, 'req-004').output.template === 'technical_support' && resOf(sb, 'req-004').output.text.includes('req-004') && reportOf(sb).trips.includes('client:client_beta'));
  check('req-005 rate limit -> regex classification "technical_support"', resOf(sb, 'req-005').output.label === 'technical_support' && resOf(sb, 'req-005').fallback.retryAfterSec === 20);
  check('req-006 timeout charged at the pre-flight estimate (provider may still bill)', resOf(sb, 'req-006').charged === 'estimate' && resOf(sb, 'req-006').cost_usd === resOf(sb, 'req-006').estimate_usd && resOf(sb, 'req-006').output.references.includes('ORD-48213'));
  const r7 = resOf(sb, 'req-007');
  check('req-007 OpenAI cached tokens: 128 x 0.75 + 512 x 0.075 + 120 x 4.50 = $0.0006744', r7.cost_usd === '0.000674400' && r7.usage.cachedTokens === 512 && r7.usage.inputTokens === 128);
  check('req-007 shared cost center split exactly 60/40 (cc-marketing / cc-sales)', r7.allocation_usd['cc-marketing'] === '0.000404640' && r7.allocation_usd['cc-sales'] === '0.000269760');
  check('req-008 missing usage -> charged at the estimate, flagged', resOf(sb, 'req-008').charged === 'estimate' && resOf(sb, 'req-008').flags.includes('USAGE_MISSING_CHARGED_ESTIMATE'));
  const ex9 = sb.last('Expand LLM Calls').find((c) => c.requestId === 'req-009');
  check('req-009 email and phone redacted before the provider body is built', JSON.stringify(ex9.body).includes('[email]') && JSON.stringify(ex9.body).includes('[phone]') && !JSON.stringify(ex9.body).includes('jane.doe') && resOf(sb, 'req-009').flags.includes('PII_REDACTED_2'));
  check('req-010 unpriced model never called; req-011 oversized input never called', !sb.last('Expand LLM Calls').some((c) => ['req-010', 'req-011'].includes(c.requestId)));
  check('req-014 global soft cap: gpt-6-astra -> gpt-6-luna', resOf(sb, 'req-014').downgraded_from === 'gpt-6-astra' && resOf(sb, 'req-014').model_used === 'gpt-6-luna');
  check('req-015 critical request bypasses the soft cap on claude-opus-5-5', resOf(sb, 'req-015').model_used === 'claude-opus-5-5' && resOf(sb, 'req-015').flags.includes('SOFT_CAP_BYPASSED_CRITICAL'));
  check('req-020 global hard-cap trip: worst-case estimate over cap minus 5% margin', decOf(sb, 'req-020').estimateNanos > 0.1 * 1e9 && reportOf(sb).trips.includes('global'));
  check('req-021 after the trip even a tiny request uses fallback rules', resOf(sb, 'req-021').output.label === 'sales_inquiry');
  const U = sb.last('Commit Spend Ledger')[0].utilization;
  const runSum = respOf(sb).results.reduce((s, r) => s + Math.round(Number(r.cost_usd) * 1e9), 0);
  check('Run spend equals the sum of per-request costs; day total = seed + run', U.runSpendNanos === runSum && U.globalSpentNanos === fixture.ledgerSeed.spentNanos.global + runSum);
  const L = sb.last('Commit Spend Ledger')[0].ledgerAfter;
  check('Ledger: clients, workflows, campaigns and cost centers each still sum to the global total', ['clients', 'workflows', 'campaigns', 'costCenters'].every((k) => Object.values(L.spentNanos[k]).reduce((a, b) => a + b, 0) === L.spentNanos.global));
  check('OpenAI breaker OPEN until next budget day (insufficient_quota is sticky)', U.breakers.openai.state === 'OPEN' && U.breakers.openai.reason === 'PROVIDER_BUDGET_EXCEEDED' && U.breakers.openai.reopenAt === '2026-11-18T00:00:00.000Z');
  check('Anthropic breaker OPEN after 3 consecutive failures, reopens after 15 min cooldown', U.breakers.anthropic.state === 'OPEN' && U.breakers.anthropic.consecutiveFailures === 3 && U.breakers.anthropic.reopenAt === '2026-11-17T14:15:00.000Z');
  const ev = reportOf(sb).events;
  check('Events: client + global soft cap, client + global trip, quota, two breakers opened', ['SOFT_CAP_REACHED:client:client_alpha', 'SOFT_CAP_REACHED:global:global', 'HARD_CAP_TRIPPED:client:client_beta', 'HARD_CAP_TRIPPED:global:global', 'PROVIDER_BUDGET_EXCEEDED:provider:openai', 'BREAKER_OPENED:provider:openai', 'BREAKER_OPENED:provider:anthropic'].every((e) => ev.includes(e)), ev.join(' '));
  check('Sandbox never writes workflow static data', sb.staticData.llmLedger === undefined && reportOf(sb).ledger.persisted === false);
  const rep = reportOf(sb);
  check('Report: 21 requests, 8 LLM (2 downgraded), 11 fallback, 2 rejected; alert BLOCKED', rep.requests.total === 21 && rep.requests.llmOk === 8 && rep.requests.downgraded === 2 && rep.requests.fallback === 11 && rep.requests.rejected === 2 && rep.alert.status === 'BLOCKED');
  const ab = sb.last('Cost Alert Builder')[0];
  check('Critical alert built (Slack within Block Kit limits) and labelled [SANDBOX]', ab.severity === 'critical' && validateSlack(ab.slackPayload).length === 0 && ab.slackPayload.blocks[0].text.text.includes('[SANDBOX]'), validateSlack(ab.slackPayload).join(';'));
  check('Teams payload is a Workflows message with an Adaptive Card 1.4 (< 28 KB)', ab.teamsPayload.type === 'message' && ab.teamsPayload.attachments[0].content.version === '1.4' && JSON.stringify(ab.teamsPayload).length < 28000);
  check('Response, alert and report never include a prompt or customer email', !/jane\.doe|010-0199/.test(JSON.stringify([respOf(sb), ab, rep])));
  fs.writeFileSync(path.join(OUT_DIR, 'sandbox-gateway-response.json'), JSON.stringify(respOf(sb), null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'sandbox-run-report.json'), JSON.stringify(rep, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'slack-blocks.json'), JSON.stringify({ blocks: ab.slackPayload.blocks }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'teams-adaptive-card.json'), JSON.stringify(ab.teamsPayload.attachments[0].content, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'alert-text-preview.txt'), ab.textPreview + '\n');

  // --------------------------------------------- 7. fallback rules + policies
  section('7. Fallback rules and budget policies');
  const fsrc = byName['Fallback Rules & Cost Allocation'].parameters.jsCode;
  const fctx = {};
  vm.runInNewContext(`const config = ${JSON.stringify(d0)}; const F = config.fallback; const MAX = config.estimation.maxInputChars; const rx = (p) => new RegExp(p, 'i');\n${['fbClassify', 'fbScore', 'fbReply', 'fbExtract', 'fbSummarize'].map((n) => grab(fsrc, n)).join('\n')}\nthis.c = fbClassify; this.s = fbScore; this.r = fbReply; this.e = fbExtract; this.m = fbSummarize;`, fctx);
  check('Classify: cancellation wins over billing; labels restrict rules; default "general"', fctx.c('Cancel my plan and refund the invoice', []).label === 'cancellation' && fctx.c('refund please', ['technical_support', 'general']).label === 'general' && fctx.c('hello there', []).label === 'general');
  check('Score: budget approved + demo + this quarter = 40+25+20+15 = 100 (A); "not interested" -> 0 (C)', fctx.s('Budget approved, we want a demo this quarter').score === 100 && fctx.s('Budget approved, we want a demo this quarter').grade === 'A' && fctx.s('not interested, unsubscribe').score === 0);
  check('Reply template substitutes only whitelisted variables, strips <>', fctx.r('There is a bug', { requestId: 'r-1', vars: {} }).text.includes('r-1') && !fctx.r('x', { requestId: '<b>', vars: {} }).text.includes('<'));
  check('Extract: amounts, ISO dates, reference IDs', JSON.stringify(fctx.e('Pay USD 1,200.50 and $30 by 2026-12-31 for INV-20391')) === JSON.stringify({ amounts: ['USD 1,200.50', '$30'], dates: ['2026-12-31'], references: ['INV-20391'], method: 'regex' }));
  check('Summarize: first two sentences, capped length', fctx.m('One. Two! Three? Four.').text === 'One. Two!');
  const pr = SB({ HARD_CAP_TRIP_MODE: 'per_request' });
  check('HARD_CAP_TRIP_MODE=per_request: only the overrunning request falls back (req-021 runs)', resOf(pr, 'req-020').fallback.reason === 'HARD_CAP_GLOBAL' && resOf(pr, 'req-021').status === 'LLM_OK' && !reportOf(pr).trips.length);
  const sf = SB({ SOFT_CAP_ACTION: 'fallback' });
  check('SOFT_CAP_ACTION=fallback: soft-cap requests use rules instead of a cheaper model', resOf(sf, 'req-003').fallback.reason === 'SOFT_CAP_CLIENT' && resOf(sf, 'req-014').fallback.reason === 'SOFT_CAP_GLOBAL');
  const nb = SB({ CRITICAL_BYPASSES_SOFT_CAP: 'false' });
  check('CRITICAL_BYPASSES_SOFT_CAP=false: critical request is downgraded like any other', resOf(nb, 'req-015').downgraded_from === 'claude-opus-5-5');
  const ks = SB({ LLM_KILL_SWITCH: 'true' });
  check('LLM_KILL_SWITCH=true: every valid request uses fallback rules, nothing simulated', respOf(ks).results.filter((r) => r.status !== 'REJECTED').every((r) => r.fallback.reason === 'KILL_SWITCH') && !ks.last('Expand LLM Calls'));
  const mx = SB({ UNPRICED_MODEL_POLICY: 'max_rate' });
  check('UNPRICED_MODEL_POLICY=max_rate: unpriced model allowed but reserved at the provider\'s highest rates', resOf(mx, 'req-010').status === 'LLM_OK' && resOf(mx, 'req-010').flags.includes('UNPRICED_MODEL_CHARGED_MAX_RATE'));
  const am = SB({ ALLOWED_MODELS: 'gpt-5-nano,gpt-5-mini,claude-haiku-5-5' });
  check('ALLOWED_MODELS blocks every other model (MODEL_NOT_ALLOWED)', resOf(am, 'req-007').fallback.reason === 'MODEL_NOT_ALLOWED' && resOf(am, 'req-001').status === 'LLM_OK');
  const ce = SB({ PER_REQUEST_MAX_USD: '0.01' });
  check('PER_REQUEST_MAX_USD: expensive request downgraded to fit, else REQUEST_COST_CEILING', resOf(ce, 'req-004').flags.includes('REQUEST_CEILING_DOWNGRADE') || resOf(ce, 'req-004').fallback.reason === 'REQUEST_COST_CEILING');
  const env1 = SB({ DAILY_HARD_CAP_USD: '50.00', BUDGETS_JSON: '{}' });
  check('Env budgets override the fixture\'s example budgets in sandbox (no trips at $50)', reportOf(env1).trips.length === 0 && resOf(env1, 'req-020').status === 'LLM_OK');
  const ce1 = SB({ CONFIG_DUMMY: '1', DAILY_SOFT_CAP_PCT: '150' });
  check('Any config error -> every request falls back (CONFIG_ERROR), nothing simulated', respOf(ce1).results.filter((r) => r.status !== 'REJECTED').every((r) => r.fallback.reason === 'CONFIG_ERROR'));
  const mo = SB({ CIRCUIT_BREAKER_ACTIVE_BY_DEFAULT: 'false' });
  check('Monitor-only: hard-cap requests proceed but are flagged "would block"', resOf(mo, 'req-020').status === 'LLM_OK' && resOf(mo, 'req-020').monitor_would_block.includes('HARD_CAP_GLOBAL') && reportOf(mo).events.some((e) => e.startsWith('MONITOR_ONLY_WOULD_BLOCK')));
  check('Monitor-only still fails closed on unpriced models and invalid requests', resOf(mo, 'req-010').fallback.reason === 'UNPRICED_MODEL' && resOf(mo, 'req-012').status === 'REJECTED');

  // --------------------------------------------- 8. ledger
  section('8. Ledger validation, rollover, breakers and persistence');
  const corrupt = runWorkflow({ env: { ...ARMED }, mocks: makeMocks(), staticData: { llmLedger: seedLedger((l) => { l.spentNanos.global = -5; }) } });
  check('Corrupt ledger (negative total) -> LEDGER_UNTRUSTED, zero provider calls, ledger left as is', respOf(corrupt).results.filter((r) => r.status !== 'REJECTED').every((r) => r.fallback.reason === 'LEDGER_UNTRUSTED') && corrupt.mocks.state.llm.length === 0 && corrupt.staticData.llmLedger.spentNanos.global === -5);
  const float = runWorkflow({ env: { ...ARMED }, mocks: makeMocks(), staticData: { llmLedger: seedLedger((l) => { l.spentNanos.clients.client_alpha = 0.5; }) } });
  check('Fractional nano amount in ledger -> untrusted (fail closed)', reportOf(float).ledger.trusted === false);
  const over = runWorkflow({ env: { ...ARMED }, mocks: makeMocks(), staticData: { llmLedger: seedLedger((l) => { l.spentNanos.clients.client_alpha += 1e9; }) } });
  check('Scope totals exceeding the global total -> untrusted', reportOf(over).ledger.trusted === false);
  const rs = runWorkflow({ env: { ...ARMED, LEDGER_RESET: 'true' }, mocks: makeMocks(), staticData: { llmLedger: { version: 99 } } });
  check('LEDGER_RESET=true replaces an invalid ledger deliberately (LEDGER_RESET event)', reportOf(rs).ledger.source === 'reset' && reportOf(rs).events.some((e) => e.startsWith('LEDGER_RESET')) && rs.staticData.llmLedger.version === 1);
  const yd = seedLedger((l) => { l.day = '2026-11-16'; l.trips = { global: { at: 'x', reason: 'HARD_CAP_GLOBAL' } }; l.alertsSent = { old: 'x' }; });
  const roll = runWorkflow({ env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks(), staticData: { llmLedger: yd } });
  check('Day rollover: yesterday archived, totals / trips / alert marks reset, history kept', reportOf(roll).ledger.rolledOver.from === '2026-11-16' && roll.staticData.llmLedger.history[0].day === '2026-11-16' && roll.staticData.llmLedger.history[0].spentNanos === yd.spentNanos.global && !roll.staticData.llmLedger.trips.global && !roll.staticData.llmLedger.alertsSent.old);
  const future = runWorkflow({ env: { ...ARMED }, mocks: makeMocks(), staticData: { llmLedger: seedLedger((l) => { l.day = '2026-11-20'; }) } });
  check('Ledger dated in the future (clock moved back) -> untrusted', reportOf(future).ledger.trusted === false);
  const openL = seedLedger((l) => { l.breakers.openai = { state: 'OPEN', consecutiveFailures: 3, openedAt: '2026-11-17T13:55:00.000Z', reopenAt: '2026-11-17T14:10:00.000Z', reason: 'RATE_LIMITED' }; });
  const op = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ(), REQ({ request_id: 'wh-002', provider: 'anthropic', model: 'claude-haiku-5-5' })] }), env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks(), staticData: { llmLedger: openL } });
  check('OPEN breaker: OpenAI request uses fallback without a call; Anthropic still called', resOf(op, 'wh-001').fallback.reason === 'BREAKER_OPEN' && op.mocks.state.llm.length === 1 && op.mocks.state.llm[0].provider === 'anthropic');
  const ho = seedLedger((l) => { l.breakers.openai = { state: 'OPEN', consecutiveFailures: 3, openedAt: '2026-11-17T13:30:00.000Z', reopenAt: '2026-11-17T13:45:00.000Z', reason: 'RATE_LIMITED' }; });
  const hop = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ(), REQ({ request_id: 'wh-002' }), REQ({ request_id: 'wh-003' })] }), env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks(), staticData: { llmLedger: ho } });
  check('Cooldown elapsed -> HALF_OPEN: exactly one probe, others fall back; probe success closes', hop.mocks.state.llm.length === 1 && resOf(hop, 'wh-002').fallback.reason === 'BREAKER_HALF_OPEN' && hop.staticData.llmLedger.breakers.openai.state === 'CLOSED' && reportOf(hop).events.some((e) => e.startsWith('BREAKER_CLOSED')));
  const hof = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks({ llm: () => ({ status: 503, body: { error: { message: 'unavailable' } } }) }), staticData: { llmLedger: clone(ho) } });
  check('HALF_OPEN probe failure re-opens immediately', hof.staticData.llmLedger.breakers.openai.state === 'OPEN' && hof.staticData.llmLedger.breakers.openai.reason === 'PROVIDER_OVERLOADED');

  // --------------------------------------------- 9. live (mocked)
  section('9. Live provider calls (mocked): request shapes, usage parsing, persistence, alerts');
  const lm = makeMocks();
  const lsd = {};
  const TIGHT = { DAILY_HARD_CAP_USD: '0.02', BUDGETS_JSON: '{}' };
  const lv = runWorkflow({ env: { ...ARMED, ...ALERTS, ...TIGHT }, mocks: lm, staticData: lsd });
  check('Armed live run (fixture batch) completes', !lv.error, lv.error && lv.error.message);
  const oa = lm.state.calls.filter((c) => c.host === 'api.openai.com');
  const an = lm.state.calls.filter((c) => c.host === 'api.anthropic.com');
  check('OpenAI calls: POST /v1/chat/completions, max_completion_tokens, store:false, Bearer key only', oa.length > 0 && oa.every((c) => c.path === '/v1/chat/completions' && c.body.store === false && Number.isInteger(c.body.max_completion_tokens) && c.headers.Authorization === `Bearer ${TOKENS.OPENAI_API_KEY}` && !c.headers['x-api-key']));
  check('Anthropic calls: POST /v1/messages, max_tokens, x-api-key + anthropic-version, no Bearer', an.length > 0 && an.every((c) => c.path === '/v1/messages' && Number.isInteger(c.body.max_tokens) && c.headers['x-api-key'] === TOKENS.ANTHROPIC_API_KEY && c.headers['anthropic-version'] === '2023-06-01' && !c.headers.Authorization));
  check('Live: same rejections as the sandbox; unpriced and oversized requests never reach a provider', respOf(lv).results.every((r) => (expected[r.request_id][0] === 'REJECTED') === (r.status === 'REJECTED')) && resOf(lv, 'req-010').fallback.reason === 'UNPRICED_MODEL' && resOf(lv, 'req-011').fallback.reason === 'INPUT_TOO_LARGE' && lm.state.llm.every((c) => !['mock-llm-x1'].includes(c.body.model)));
  const rm = makeMocks();
  runWorkflow({ env: { ...ARMED }, mocks: rm, staticData: {} });
  check('Live (default $5 cap): every valid priced request is sent; req-009 body redacted before leaving n8n', rm.state.llm.length === 17 && rm.state.llm.some((c) => JSON.stringify(c.body).includes('[email]')) && !JSON.stringify(rm.state.llm).includes('jane.doe'), String(rm.state.llm.length));
  check('Ledger persisted to static data with this run\'s spend', lsd.llmLedger && lsd.llmLedger.spentNanos.global === respOf(lv).results.reduce((s, r) => s + Math.round(Number(r.cost_usd) * 1e9), 0) + 0 && reportOf(lv).ledger.persisted);
  check('Alert posted to Slack and Teams; events marked sent for the day', lm.state.posts.length === 2 && reportOf(lv).alert.status === 'POSTED' && Object.keys(lsd.llmLedger.alertsSent).length > 0);
  check('No API key or webhook URL appears in any item, response or provider body', Object.values(TOKENS).filter((t) => t !== TOKENS.WEBHOOK_SHARED_SECRET).every((t) => !JSON.stringify(lv.runData).includes(t)) && !JSON.stringify(lm.state.calls.filter((c) => c.host.startsWith('api.')).map((c) => c.body)).includes('sim-placeholder'));
  const spent1 = lsd.llmLedger.spentNanos.global;
  const again = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ({ model: 'gpt-5.5', max_output_tokens: 2048 })] }), env: { ...ARMED, ...ALERTS, ...TIGHT, NOW_OVERRIDE: '2026-11-17T14:05:00.000Z' }, mocks: lm, staticData: lsd });
  check('Second run same day: global scope still tripped (persisted), no duplicate alert', resOf(again, 'wh-001').fallback.reason === 'HARD_CAP_TRIPPED' && lm.state.posts.length === 2 && reportOf(again).alert.status === 'NO_ALERT_NEEDED' && lsd.llmLedger.spentNanos.global === spent1);
  runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: { ...ARMED, ...ALERTS, ...TIGHT, FORCE_ALERT: 'true', NOW_OVERRIDE: '2026-11-17T14:06:00.000Z' }, mocks: lm, staticData: lsd });
  check('FORCE_ALERT=true re-posts deliberately', lm.state.posts.length === 4);
  const usageRuns = [
    ['OpenAI usage with reasoning tokens billed as output', 'openai', 'gpt-5.4', { status: 200, body: { model: 'gpt-5.4', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 300 } } } }, 800 * 2500000 + 200 * 250000 + 500 * 15000000],
    ['Responses-API usage shape (input_tokens / output_tokens)', 'openai', 'gpt-5-mini', { status: 200, body: { model: 'gpt-5-mini', output_text: 'ok', usage: { input_tokens: 400, output_tokens: 50, input_tokens_details: { cached_tokens: 100 } } } }, 300 * 250000 + 100 * 25000 + 50 * 2000000],
    ['Anthropic cache write billed at the 5-minute write rate', 'anthropic', 'claude-sonnet-5-5', { status: 200, body: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 50, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0, output_tokens: 100 } } }, 50 * 2000000 + 4000 * 2500000 + 100 * 10000000],
    ['Haiku 5.5 long-context tier when prompt incl. cache > 100K tokens', 'anthropic', 'claude-haiku-5-5', { status: 200, body: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 99000, output_tokens: 10 } } }, 2000 * 500000 + 99000 * 50000 + 10 * 2500000],
  ];
  for (const [label, provider, model, reply, pico] of usageRuns) {
    const r = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ({ provider, model, max_output_tokens: 600 })] }), env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks({ llm: () => reply }), staticData: {} });
    const x = resOf(r, 'wh-001');
    check(`${label}: $${(pico / 1e12).toFixed(9)}`, x.cost_usd === (Math.ceil(pico / 1000) / 1e9).toFixed(9), `${x.cost_usd} ${JSON.stringify(x.usage)}`);
  }
  const bad1 = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks({ llm: () => ({ status: 200, body: { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: -4, completion_tokens: 2.5 } } }) }), staticData: {} });
  check('Negative / fractional token counts -> charged at estimate, flagged USAGE_INVALID', resOf(bad1, 'wh-001').charged === 'estimate' && resOf(bad1, 'wh-001').flags.includes('USAGE_INVALID_CHARGED_ESTIMATE'));
  const bad2 = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks({ llm: () => ({ status: 200, body: { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 99 } } }) }), staticData: {} });
  check('total_tokens mismatch is flagged (USAGE_TOTAL_MISMATCH)', resOf(bad2, 'wh-001').flags.includes('USAGE_TOTAL_MISMATCH'));
  const to = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks({ llm: () => 'timeout' }), staticData: {} });
  check('Transport timeout from the HTTP node -> LLM_TIMEOUT fallback, charged at estimate', resOf(to, 'wh-001').fallback.reason === 'LLM_TIMEOUT' && resOf(to, 'wh-001').charged === 'estimate' && resOf(to, 'wh-001').output.label === 'technical_support');
  const au = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: { ...ARMED, BUDGETS_JSON: '{}', OPENAI_API_KEY: 'wrong-key' }, mocks: makeMocks(), staticData: {} });
  check('401 from the provider -> PROVIDER_AUTH_ERROR fallback, zero cost', resOf(au, 'wh-001').fallback.reason === 'PROVIDER_AUTH_ERROR' && resOf(au, 'wh-001').cost_usd === '0.000000000');
  const cb = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ({ provider: 'anthropic', model: 'claude-haiku-5-5' })] }), env: { ...ARMED, BUDGETS_JSON: '{}' }, mocks: makeMocks({ llm: () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }) }), staticData: {} });
  check('Anthropic "credit balance is too low" -> PROVIDER_BUDGET_EXCEEDED, breaker open until next day', resOf(cb, 'wh-001').fallback.reason === 'PROVIDER_BUDGET_EXCEEDED' && cb.staticData.llmLedger.breakers.anthropic.reopenAt === '2026-11-18T00:00:00.000Z');
  const nk = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ({ provider: 'anthropic', model: 'claude-haiku-5-5' })] }), env: { ...ARMED, BUDGETS_JSON: '{}', ANTHROPIC_API_KEY: '' }, mocks: makeMocks(), staticData: {} });
  check('Missing provider key -> PROVIDER_KEY_MISSING fallback, no call', resOf(nk, 'wh-001').fallback.reason === 'PROVIDER_KEY_MISSING' && nk.mocks.state.llm.length === 0);
  const dr = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: { ...ARMED, ...ALERTS, DRY_RUN: 'true' }, mocks: makeMocks(), staticData: {} });
  check('DRY_RUN=true with everything else armed: zero provider calls, zero posts, nothing persisted', dr.mocks.state.calls.length === 0 && resOf(dr, 'wh-001').fallback.reason === 'DRY_RUN' && resOf(dr, 'wh-001').would_route === 'llm' && dr.staticData.llmLedger === undefined);
  const off = runWorkflow({ trigger: 'webhook', webhookItem: hook({ requests: [REQ()] }), env: { ...ARMED, LLM_CALLS_ENABLED: 'false' }, mocks: makeMocks(), staticData: {} });
  check('LLM_CALLS_ENABLED not true: fallback rules only (LLM_CALLS_DISABLED)', resOf(off, 'wh-001').fallback.reason === 'LLM_CALLS_DISABLED' && off.mocks.state.calls.length === 0);
  const fsd = {};
  const fail = runWorkflow({ env: { ...ARMED, ...ALERTS, ...TIGHT, ALERT_CHANNELS: 'slack' }, mocks: makeMocks({ failSlack: true }), staticData: fsd });
  check('Alert post failure -> POST_FAILED and events NOT marked as sent (will retry next run)', reportOf(fail).alert.status === 'POST_FAILED' && Object.keys(fsd.llmLedger.alertsSent).length === 0);
  const dsd = { llmLedger: seedLedger() };
  const dig = runWorkflow({ trigger: 'schedule', env: { ...ARMED, ...ALERTS, BUDGETS_JSON: '{}' }, mocks: makeMocks(), staticData: dsd });
  check('Daily digest schedule: no provider calls, digest posted', !dig.error && dig.mocks.state.llm.length === 0 && reportOf(dig).alert.status === 'POSTED' && dig.mocks.state.posts.length === 2, dig.error && dig.error.message);
  fs.writeFileSync(path.join(OUT_DIR, 'live-mock-run-report.json'), JSON.stringify(reportOf(lv), null, 2) + '\n');

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  const s = reportOf(sb);
  console.log(`Sandbox: ${s.requests.total} requests -> ${s.requests.llmOk} LLM (${s.requests.downgraded} downgraded), ${s.requests.fallback} fallback, ${s.requests.rejected} rejected; day spend $${s.spend.day_total_usd} of $${s.spend.day_hard_cap_usd} (${s.spend.day_pct_of_cap}%), trips: ${s.trips.join(', ')}`);
  console.log('Output written to: sim-output/ (git-ignored)');
  if (failed) { console.log('\nFailures:\n' + failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
})();
