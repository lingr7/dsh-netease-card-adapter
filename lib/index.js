// dsh-netease-card-adapter — 宿主侧：命令队列 + netease_music 工具 + 诊断日志。
//
// 为什么要有这一层：以前"让卡片播什么"要改 vendor 插件的 lib/index.js（加路由、
// 加队列）和 lib/client.js（加轮询、加 status 命令）。升级一次就全丢，而且失败
// 是静默的。现在队列和回执都归我们自己，vendor 只提供那张卡片 —— 页面里的
// 适配器（lib/client.js）负责"按按钮、拖滑块、填搜索框"，宿主这边只管排队。
//
// 队列在页面里被消费：适配器每 1.5 秒 GET /api/next，执行完 POST /api/ack。
// 回执按 id 匹配，所以不会再出现"把上一条旧回执当成这次结果"的问题。
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const inject = ['tools', 'webServer'];

const ROUTE = '/dsh-netease-card';
const LOG_PATH = join(tmpdir(), 'dsh-netease-card.log');
const ACK_TIMEOUT_MS = 10000;
const ACK_POLL_MS = 200;

const pending = [];
let ack = null;
let seq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

async function trace(text) {
  try {
    await appendFile(LOG_PATH, new Date().toISOString() + ' ' + text + '\n', 'utf8');
  } catch {
    // 日志失败不影响按键
  }
}

function enqueue(command) {
  const id = 'c' + Date.now().toString(36) + '-' + (++seq);
  pending.push({ id, ...command });
  trace('enqueue ' + id + ' ' + command.type + (command.query ? ' ' + command.query : '') + (command.value != null ? ' ' + command.value : ''));
  return id;
}

async function waitForAck(id, timeoutMs = ACK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ack && ack.id === id) return ack;
    await sleep(ACK_POLL_MS);
  }
  return null;
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const percent = (value) => Math.round(clamp01(Number(value) || 0) * 100);

function messageOf(result, action) {
  if (!result) {
    return '卡片没有响应：DSH 页面没打开，或者卡片没挂载（vendor 插件被禁用？）。';
  }
  if (!result.ok) {
    return '卡片拒绝了这次操作：' + (result.message || '未知原因');
  }
  const title = String(result.title || '');
  const artist = String(result.artist || '');
  const where = title ? title + (artist ? ' — ' + artist : '') : '已更新';
  const volume = Number(result.volume);
  const parts = [];
  // 不再对 play/next 说「已切歌」——回执里已经是歌名 + 真实播放状态，
  // 拐个弯说「已切歌」只会掩盖"其实没换歌"这种问题。
  parts.push(result.playing ? '正在播放' : '已暂停');
  if (Number.isFinite(volume)) parts.push('音量 ' + percent(volume) + '%');
  return '网易云卡片：' + where + '（' + parts.join('，') + '）';
}

function handle(req, res, url) {
  const path = url.pathname.slice(ROUTE.length);

  if (path === '/log' && req.method === 'POST') {
    void readBody(req).then((body) => {
      const line = body && body.text ? String(body.text).slice(0, 4000) : '';
      if (line) void trace(line);
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/command' && req.method === 'POST') {
    void readBody(req).then((body) => {
      if (!body || !body.type) return sendJson(res, 400, { ok: false, error: 'type required' });
      const id = enqueue(body);
      sendJson(res, 200, { ok: true, id });
    });
    return;
  }

  if (path === '/api/next' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, command: pending.shift() || null, pending: pending.length });
    return;
  }

  if (path === '/api/ack' && req.method === 'POST') {
    void readBody(req).then((body) => {
      if (body && body.id) {
        ack = { ...body, at: Date.now() };
        trace('ack ' + body.id + ' ok=' + body.ok + (body.title ? ' ' + body.title : ''));
      }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (path === '/api/state' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, pending: pending.length, ack });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler(req, res) {
      // 队列是这个插件的私有通道：只认页面带上的标记头。跨站页面加不了自定义
      // 请求头（会触发预检并被拒），本机其它程序的偶然请求也会被挡在外面。
      if (req.headers['x-dsh-netease-card'] !== '1') {
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      handle(req, res, url);
    },
  }), 'dsh-netease-card-adapter: routes');

  ctx.effect(() => ctx.tools.register({
    name: 'netease_music',
    description: [
      '控制 DSH 右上角那张「网易云音乐」悬浮卡片（不是左侧栏的「音乐」播放器）。',
      'action=play 用 query 点歌：「歌名 歌手」，卡片里搜索并播放第一条结果；',
      'action=search 只搜索不播放；action=pause/next/prev 控制播放；',
      'action=volume 调音量：给 volume 设绝对值（0..1 或 0..100），或给 delta 做相对调整（-5 或 -0.05 表示降 5%）；',
      'action=status 返回卡片真实状态（歌名、歌手、是否在播、音量百分比）；action=open/close 开关卡片。',
      '用户说「放一首…」「来点…」「切下一首」「声音小一点」「现在放的什么」时用它，不要用 music_control。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'search', 'pause', 'next', 'prev', 'volume', 'status', 'open', 'close'],
          description: '要执行的动作。',
        },
        query: { type: 'string', description: 'action=play/search 时的「歌名 歌手」。' },
        volume: { type: 'number', description: 'action=volume 时的目标音量，0..1 或 0..100。' },
        delta: {
          type: 'number',
          description: 'action=volume 时的相对增量：-0.05 或 -5 表示调低 5%，正数调高。与 volume 二选一。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          title: { type: 'string' },
          artist: { type: 'string' },
          playing: { type: 'boolean' },
          volume: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: String((value && value.message) || 'netease_music') }],
    },
    async execute(args) {
      const action = String((args && args.action) || '').trim();
      const query = String((args && args.query) || '').trim();

      if (action === 'play' || action === 'search') {
        if (!query) return { ok: false, message: action + ' 需要一个 query，例如「许嵩 山水之间」。' };
        const id = enqueue({ type: action, query });
        const result = await waitForAck(id);
        return {
          ok: Boolean(result && result.ok),
          title: String((result && result.title) || ''),
          artist: String((result && result.artist) || ''),
          playing: Boolean(result && result.playing),
          ...(Number.isFinite(Number(result && result.volume)) ? { volume: clamp01(Number(result.volume)) } : {}),
          message: messageOf(result, action),
        };
      }

      if (action === 'status') {
        const id = enqueue({ type: 'status' });
        const result = await waitForAck(id);
        if (!result) return { ok: false, message: messageOf(null, 'status') };
        const volume = Number(result.volume);
        return {
          ok: Boolean(result.ok),
          title: String(result.title || ''),
          artist: String(result.artist || ''),
          playing: Boolean(result.playing),
          ...(Number.isFinite(volume) ? { volume: clamp01(volume) } : {}),
          message: messageOf(result, 'status'),
        };
      }

      if (action === 'volume') {
        let value = Number(args && args.volume);
        const delta = Number(args && args.delta);
        if (!Number.isFinite(value) && Number.isFinite(delta) && delta !== 0) {
          const current = enqueue({ type: 'status' });
          const live = await waitForAck(current);
          const now = Number(live && live.volume);
          if (!Number.isFinite(now)) return { ok: false, message: '读不到当前音量，没法做相对调整；请改用 volume 给绝对值。' };
          const step = Math.abs(delta) > 1 ? delta / 100 : delta;
          value = clamp01(now + step);
        }
        if (!Number.isFinite(value)) return { ok: false, message: 'volume 需要 0..1 或 0..100 的数值，或者用 delta 做相对调整。' };
        const id = enqueue({ type: 'volume', value: clamp01(value) });
        const result = await waitForAck(id);
        return {
          ok: Boolean(result && result.ok),
          title: String((result && result.title) || ''),
          artist: String((result && result.artist) || ''),
          playing: Boolean(result && result.playing),
          volume: clamp01(value),
          message: messageOf(result, 'volume'),
        };
      }

      if (action === 'pause' || action === 'next' || action === 'prev' || action === 'open' || action === 'close') {
        const id = enqueue({ type: action });
        const result = await waitForAck(id);
        return {
          ok: Boolean(result && result.ok),
          title: String((result && result.title) || ''),
          artist: String((result && result.artist) || ''),
          playing: Boolean(result && result.playing),
          ...(Number.isFinite(Number(result && result.volume)) ? { volume: clamp01(Number(result.volume)) } : {}),
          message: messageOf(result, action),
        };
      }

      return { ok: false, message: '未知 action：' + action };
    },
  }), 'dsh-netease-card-adapter: tool');
}
