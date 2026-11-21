// dsh-netease-card-adapter — 页面侧：只通过卡片暴露的 DOM 句柄驱动它。
//
// 这是"解耦"的落点：vendor 插件（dsh-netease-music）仍然是卡片、播放器和搜索
// 的唯一实现，我们一行都不改它；我们只用它给按钮写的 aria-label、给滑块和
// 搜索框写的类名，做和用户点鼠标一模一样的事。
//
// 依赖的句柄（全部来自 vendor 的渲染代码）：
//   .nm-card / .nm-mini            卡片 / 收起后的迷你条
//   button[aria-label=上一首|下一首|播放|暂停|收起|音量]
//   input.nm-range[aria-label=音量] 音量滑块（0..100）
//   input.nm-input                 搜索框（Enter 触发搜索）
//   .nm-title / .nm-sub            歌名 / 歌手·专辑
//
// 任何一个句柄消失都不会崩，只是对应命令返回失败并留下一条 trace —— 这比"改
// vendor 源码后升级静默失效"好定位得多。
window.__ModuleLoader__.load({
  id: 'dsh-netease-card-adapter',
  factory(require) {
    const API = '/dsh-netease-card';
    const POLL_MS = 1500;
    const HUB_RETRY_MS = 400;

    const SEL = {
      card: '.nm-card',
      mini: '.nm-mini',
      fab: '.nm-fab',
      title: '.nm-title',
      sub: '.nm-sub',
      input: 'input.nm-input',
      range: 'input.nm-range',
      result: '.nm-result',
      play: 'button[aria-label="播放"]',
      pause: 'button[aria-label="暂停"]',
      prev: 'button[aria-label="上一首"]',
      next: 'button[aria-label="下一首"]',
      close: 'button[aria-label="收起"]',
    };

    function trace(text) {
      try {
        fetch(API + '/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-netease-card': '1' },
          body: JSON.stringify({ at: new Date().toISOString(), text }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // ignore
      }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function card() {
      return document.querySelector(SEL.card);
    }

    function mini() {
      return document.querySelector(SEL.mini);
    }

    function buttonIn(root, selector) {
      return root ? root.querySelector(selector) : null;
    }

    // 自检只在"需要的时候"跑：刚挂载那一瞬间 vendor 的卡片还没渲染，立刻自检会
    // 误报"全都缺"，反而掩盖真正的问题。
    function reportMissing(tag) {
      const missing = Object.entries(SEL)
        .filter(([, selector]) => !document.querySelector(selector))
        .map(([name]) => name);
      trace(tag + ' missing=' + (missing.length ? missing.join(',') : 'none'));
      return missing;
    }

    async function ensureOpen(timeoutMs = 1200) {
      if (card()) return true;
      // 卡片关着时 vendor 有两种入口：有歌是 .nm-mini（迷你条），没歌是 .nm-fab（圆按钮）。
      const entry = mini() || document.querySelector(SEL.fab);
      if (!entry) {
        reportMissing('no-entry');
        return false;
      }
      entry.click();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(80);
        if (card()) return true;
      }
      return Boolean(card());
    }

    function readState() {
      const root = card() || mini();
      if (!root) return null;
      const titleNode = root.querySelector(SEL.title) || root.querySelector('.nm-mini-title');
      const subNode = root.querySelector(SEL.sub) || root.querySelector('.nm-mini-sub');
      const title = (titleNode || {}).textContent || '';
      const sub = (subNode || {}).textContent || '';
      const artist = String(sub).split('·')[0].trim();
      const range = root.querySelector(SEL.range) || document.querySelector(SEL.range);
      const playing = Boolean(root.querySelector(SEL.pause));
      return {
        title: String(title).trim(),
        artist,
        playing,
        volume: range ? Number(range.value) / 100 : undefined,
      };
    }

    // React 受控 input：直接改 .value 不会触发 onChange，必须走原型上的原生
    // setter，再派发 input 事件，React 才认这是"用户输入"。
    function setNativeValue(element, value) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, String(value));
      else element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function pressEnter(element) {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }

    function clickLabel(label) {
      const root = card() || document.body;
      const target = root.querySelector('button[aria-label="' + label + '"]');
      if (!target) return false;
      target.click();
      return true;
    }

    // 遥控器没有屏幕：任何"按了但什么都没发生"都是 bug。owner 的处理函数可以返回
    // 字符串让 hub 弹提示；异步流程里拿不到返回值，就直接调 hub 的 notify。
    function notify(text) {
      if (!text) return;
      try {
        const hub = window.__DSH_REMOTE_HUB__;
        if (hub && typeof hub.notify === 'function') hub.notify(text);
      } catch {
        // 提示失败不影响按键本身
      }
    }

    async function waitFor(predicate, timeoutMs, stepMs = 150) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = predicate();
        if (found) return found;
        await sleep(stepMs);
      }
      return null;
    }

    async function waitChange(before, timeoutMs) {
      // before 为空说明之前没有歌：任何"有歌名 + 在播"都算变化，但要给它一点时间，
      // 不能一上来就把卡片里残留的旧状态当成结果（踩过一次）。
      const deadline = Date.now() + timeoutMs;
      const settleAt = before ? 0 : Date.now() + 1200;
      while (Date.now() < deadline) {
        await sleep(250);
        const now = readState();
        if (Date.now() < settleAt) continue;
        if (now && now.title && now.title !== before) return now;
        if (now && now.playing && !before) return now;
      }
      return readState();
    }

    async function runCommand(command) {
      const type = command.type;
      const before = readState();

      if (type === 'status') {
        // 卡片收起时页面上只剩 .nm-fab（甚至只有迷你条），此时读不到歌名和音量。
        // status 是"现在放的什么"，用户问这句话时打开卡片是符合预期的。
        const opened = await ensureOpen();
        const state = readState();
        if (!state) return { ok: false, message: '卡片不在页面上（vendor 插件没挂载或页面是旧版本）' };
        return { ok: Boolean(opened), ...state, message: '' };
      }

      if (type === 'open') {
        const opened = await ensureOpen();
        return opened ? { ok: true, ...readState(), message: '' } : { ok: false, message: '找不到卡片，也没有迷你条' };
      }

      if (type === 'close') {
        if (!card()) return { ok: true, ...(readState() || {}), message: '' };
        clickLabel('收起');
        return { ok: true, message: '' };
      }

      if (type === 'play' || type === 'search') {
        const opened = await ensureOpen();
        if (!opened) return { ok: false, message: '找不到卡片，也没有迷你条' };
        const input = document.querySelector(SEL.input);
        if (!input) return { ok: false, message: '卡片上没有搜索框' };
        const previous = (readState() || {}).title || '';
        // 上一次搜索的结果行还留在 DOM 里：按下回车后立刻取第一行，点到的是旧结果
        // （这就是"点了《庐州月》却放了上一首"的原因）。所以先记下当前第一行的文本，
        // 回车后必须等到"第一行换了内容"才算这次搜索的结果到位。
        const staleRow = document.querySelector(SEL.result);
        const staleText = staleRow ? String(staleRow.textContent || '') : '';
        setNativeValue(input, command.query || '');
        input.dispatchEvent(new Event('change', { bubbles: true }));
        pressEnter(input);
        // 回车只是"搜索"，不会自动播 —— 结果列表出来后必须点第一行才真正播放。
        const firstResult = await waitFor(() => {
          const rows = document.querySelectorAll(SEL.result);
          if (!rows.length) return null;
          const first = rows[0];
          if (staleText && String(first.textContent || '') === staleText) return null;
          return first;
        }, 8000);
        // 万一搜到的还是同一批结果（重复点同一首歌），上面的"内容必须变"永远等不到，
        // 这时退回到"第一行存在就点它"，避免把一次正常的重复点歌判成失败。
        const firstResultReady = firstResult || document.querySelector(SEL.result);
        const total = document.querySelectorAll(SEL.result).length;
        if (type === 'search') {
          if (!total) return { ok: false, message: '搜索没返回结果（可能没搜到）' };
          return { ok: true, ...(readState() || {}), message: '搜索到 ' + total + ' 条' };
        }
        if (!firstResultReady) return { ok: false, message: '搜索没返回结果，没法播放（换个关键词试试）' };
        firstResultReady.click();
        const after = await waitChange(previous, 12000);
        if (!after) return { ok: false, message: '点了第一行但没读到卡片状态' };
        return { ok: true, ...after, message: '' };
      }

      if (type === 'pause' || type === 'toggle') {
        const opened = await ensureOpen();
        if (!opened) return { ok: false, message: '找不到卡片，也没有迷你条' };
        const nowPlaying = Boolean(card() && card().querySelector(SEL.pause));
        if (nowPlaying) clickLabel('暂停');
        else clickLabel('播放');
        await sleep(400);
        return { ok: true, ...(readState() || {}), message: '' };
      }

      if (type === 'next' || type === 'prev') {
        const opened = await ensureOpen();
        if (!opened) return { ok: false, message: '找不到卡片，也没有迷你条' };
        const previous = (readState() || {}).title || '';
        clickLabel(type === 'next' ? '下一首' : '上一首');
        const after = await waitChange(previous, 6000);
        return { ok: true, ...(after || {}), message: '' };
      }

      if (type === 'volume') {
        const opened = await ensureOpen();
        if (!opened) return { ok: false, message: '找不到卡片，也没有迷你条' };
        const range = document.querySelector(SEL.range);
        if (!range) return { ok: false, message: '卡片上没有音量滑块' };
        const value = Math.max(0, Math.min(1, Number(command.value)));
        setNativeValue(range, Math.round(value * 100));
        await sleep(250);
        return { ok: true, ...(readState() || {}), message: '' };
      }

      return { ok: false, message: '不支持的命令：' + type };
    }

    // ---- 遥控器：注册成 hub 的 owner（而不是自己抢 keydown）----
    // 迷你条和圆形入口上没有音量滑块，所以"调音量"必须先把卡片展开 —— 否则按键会
    // 静默失败（这是用户报的第一个真问题）。展开是顺手的副作用，提示会说清楚。
    async function nudgeVolume(delta) {
      let range = document.querySelector(SEL.range);
      if (!range) {
        if (!(await ensureOpen(1200))) {
          notify('找不到音乐卡片');
          return '';
        }
        range = document.querySelector(SEL.range);
      }
      if (!range) {
        notify('卡片上没有音量滑块');
        return '';
      }
      const current = Number(range.value) / 100;
      const next = Math.max(0, Math.min(1, Math.round((current + delta) * 100) / 100));
      setNativeValue(range, Math.round(next * 100));
      await sleep(120);
      notify('音量 ' + Math.round(next * 100) + '%');
      return '';
    }

    function mediaOwner() {
      return {
        id: 'netease-card-media',
        priority: 20,
        active: () => true,
        commands: {
          VOLUME_UP: () => nudgeVolume(0.05),
          VOLUME_DOWN: () => nudgeVolume(-0.05),
          PLAY_TOGGLE: () => {
            if (!card() && !mini()) {
              notify('还没有歌在放（先说一句"放首歌"）');
              return '';
            }
            const playing = Boolean(card() && card().querySelector(SEL.pause));
            if (!clickLabel(playing ? '暂停' : '播放')) {
              notify('没找到播放键');
              return '';
            }
            notify(playing ? '暂停' : '播放');
            return '';
          },
          PREV: () => (!clickLabel('上一首') ? (notify('还没有歌在放'), '') : (notify('上一首'), '')),
          NEXT: () => (!clickLabel('下一首') ? (notify('还没有歌在放'), '') : (notify('下一首'), '')),
        },
      };
    }

    function navOwner() {
      return {
        id: 'netease-card-nav',
        priority: 20,
        active: () => Boolean(card()),
        commands: {
          NAV_LEFT: () => { clickLabel('上一首'); return ''; },
          NAV_RIGHT: () => { clickLabel('下一首'); return ''; },
        },
      };
    }

    function apply(ctx) {
      let stopped = false;
      let offMedia = null;
      let offNav = null;

      trace('adapter ready');
      // vendor 的入口组件稍后才渲染，自检推迟到 1.5s。
      setTimeout(() => { if (!stopped) reportMissing('selfcheck'); }, 1500);

      async function attachHub() {
        for (let i = 0; i < 75 && !stopped; i += 1) {
          const hub = window.__DSH_REMOTE_HUB__;
          if (hub && typeof hub.register === 'function') {
            offMedia = hub.register(mediaOwner());
            offNav = hub.register(navOwner());
            trace('hub attached media+nav');
            return;
          }
          await sleep(HUB_RETRY_MS);
        }
        trace('hub missing after retry — 遥控键不会由本插件接管');
      }

      attachHub();

      async function loop() {
        while (!stopped) {
          try {
            const response = await fetch(API + '/api/next', {
              signal: AbortSignal.timeout(4000),
              headers: { 'x-dsh-netease-card': '1' },
            });
            const payload = await response.json();
            const command = payload && payload.command;
            if (command) {
              let result;
              try {
                result = await runCommand(command);
              } catch (error) {
                result = { ok: false, message: String((error && error.message) || error) };
              }
              await fetch(API + '/api/ack', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-dsh-netease-card': '1' },
                body: JSON.stringify({ id: command.id, ...result }),
              }).catch(() => {});
              trace('done ' + command.id + ' ' + command.type + ' ok=' + Boolean(result && result.ok));
            }
          } catch {
            // 宿主还没起来 / 页面在卸载：下一轮再试
          }
          await sleep(POLL_MS);
        }
      }

      loop();

      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'netease-card-adapter', order: 38 },
        () => null,
      ));

      ctx.effect(() => () => {
        stopped = true;
        if (typeof offMedia === 'function') offMedia();
        if (typeof offNav === 'function') offNav();
      }, 'dsh-netease-card-adapter: poller');
    }

    return { name: 'dsh-netease-card-adapter', inject: ['slots'], apply };
  },
});
