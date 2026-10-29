// ==UserScript==
// @name         多点自动点击
// @namespace    local.garden.clicker
// @version      1.3.3
// @updateURL    none
// @downloadURL  none
// @description  多点顺序点击；坐标仅本次页面有效；支持延迟开始、限时运行与单按钮收起。
// @match        https://*/*
// @match        http://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  const CHANNEL = 'garden-click-bridge-v1';
  const TARGET_KEY = 'clicker-local-target';
  const localTarget = GM_getValue(TARGET_KEY, null);
  if (window === window.top) {
    GM_registerMenuCommand('在当前页面启用点击面板（仅本地）', () => {
      GM_setValue(TARGET_KEY, { origin: location.origin, path: location.pathname });
      location.reload();
    });
    GM_registerMenuCommand('取消绑定点击页面（仅本地）', () => {
      GM_setValue(TARGET_KEY, null);
      location.reload();
    });
  }
  if (!localTarget || typeof localTarget.origin !== 'string' || typeof localTarget.path !== 'string') return;
  const trustedOrigin = origin => origin === localTarget.origin;
  const isGame = trustedOrigin(location.origin) && location.pathname === localTarget.path;
  const hostedByGame = [...(location.ancestorOrigins || [])].some(trustedOrigin);
  // 跨域 iframe 需要按其自身地址注入；其他顶层网页立即退出，不显示面板。
  if (window === window.top && !isGame) return;
  if (window !== window.top && !hostedByGame) return;
  /** 将归一化坐标传入子页面，并等待回执。 */
  function forwardClick(frame, x, y, mode) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const destination = frame.contentWindow;
      const listener = e => {
        const data = e.data;
        if (e.source !== destination || !data || data.channel !== CHANNEL || data.id !== id || data.type !== 'result') return;
        clearTimeout(timer); window.removeEventListener('message', listener);
        data.error ? reject(Error(data.error)) : resolve();
      };
      const timer = setTimeout(() => {
        window.removeEventListener('message', listener);
        reject(Error('iframe 未响应：保存新版脚本后刷新整个游戏页面，并确认油猴允许在游戏子页面运行'));
      }, 3000);
      window.addEventListener('message', listener);
      destination.postMessage({ channel:CHANNEL, type:'click', id, x, y, mode }, '*');
    });
  }
  /** 将视口坐标换算到 iframe 内容区域；由调用方等待回执。 */
  function clickFrame(frame, x, y, mode) {
    const r=frame.getBoundingClientRect();
    const sx=r.width/frame.offsetWidth, sy=r.height/frame.offsetHeight;
    const rx=(x-r.left-frame.clientLeft*sx)/(frame.clientWidth*sx);
    const ry=(y-r.top-frame.clientTop*sy)/(frame.clientHeight*sy);
    return forwardClick(frame,rx,ry,mode);
  }
  if (window !== window.top) {
    window.addEventListener('message', async e => {
      const d=e.data;
      if (e.source!==window.parent || !d || d.channel!==CHANNEL || d.type!=='click' || typeof d.id!=='string') return;
      if (!['pointer','mouse','touch'].includes(d.mode)) return;
      const result = {channel:CHANNEL,type:'result',id:d.id,error:null};
      try {
        const x=d.x*innerWidth, y=d.y*innerHeight;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x<0 || y<0 || x>=innerWidth || y>=innerHeight) throw Error('iframe 内坐标超出可见区域');
        const target=document.elementFromPoint(x,y);
        if (!target) throw Error('iframe 内没有找到点击目标');
        if (target.tagName==='IFRAME') await clickFrame(target,x,y,d.mode);
        else dispatchAt(target,x,y,d.mode);
      } catch(err) { result.error=err.message; }
      e.source.postMessage(result,e.origin==='null'?'*':e.origin);
    });
    return;
  }
  const KEY = 'garden-clicker-v1';
  const MODE = 'pointer';
  const defaults = { gap: 100, delay: 0, duration: 30, left: 0, top: 0 };
  let previous;
  try { previous = JSON.parse(GM_getValue(KEY, '{}')) || {}; }
  catch { previous = {}; }
  const config = { points: [] };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = key === 'gap' ? Number(previous[key]) : NaN;
    config[key] = Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  let running = false, folded = true, generation = 0, cancelWait = null, picking = false, cleanupPick = null;
  let stopTimer = null, runDeadline = Infinity, hintTimer = null, delayDeadline = 0;
  let completedClicks = 0;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0px;top:0px;z-index:2147483647';
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{font:13px/1.5 system-ui,'Microsoft YaHei',sans-serif;color:#e6edf8}
    *{box-sizing:border-box} .box{width:400px;max-width:95vw;background:#172131;border:1px solid #47556c;border-radius:12px;box-shadow:0 8px 28px #0006;overflow:hidden}
    header{padding:10px 12px;background:#233247;cursor:move;touch-action:none;display:flex;justify-content:space-between;align-items:center}
    main{padding:12px} p{margin:6px 0;color:#b7c6db} button,select,input{font:inherit;border:1px solid #52647c;border-radius:5px;background:#25354c;color:#fff;padding:5px}
    button{cursor:pointer} button:hover{background:#3a5271} button:disabled{opacity:.45;cursor:default} input{width:76px} label{display:inline-flex;gap:5px;align-items:center;margin:4px 8px 4px 0}
    .bar{display:flex;gap:7px;align-items:center;margin:8px 0}.aim{font-size:24px;width:48px;height:45px;color:#7ee5ff;touch-action:none;cursor:crosshair}.go{background:#18784b}.stop{background:#9d3442}
    .box.compact{width:max-content;max-width:none;border-radius:8px}
    .box.compact>header,.box.compact>main{display:none}
    #compactAction{display:block;min-width:56px;min-height:36px;border:0;border-radius:7px;padding:7px 12px;white-space:nowrap}
    .rows{max-height:230px;overflow:auto}.row{display:flex;align-items:center;gap:5px;padding:6px 0;border-bottom:1px solid #334257}.row input{width:62px}.row small{color:#aac4dc}.row button{padding:3px 6px}
    #status{padding:8px;background:#0f1825;border-radius:5px;overflow-wrap:anywhere} .hint{font-size:12px} [hidden]{display:none!important}
  </style><section class="box"><header><b>多点自动点击</b><button id="fold">收起</button></header><main>
    <div class="bar"><button class="aim" id="aim" title="按住拖到目标位置后松开">⊕</button><span>拖动准星到目标，松开添加坐标<br><small>也可点“取点”，再点画面位置</small></span><button id="pick">取点</button></div>
    <p class="hint">优先记录 Canvas 相对坐标；其他位置记录视口坐标。取点不会提交点击。</p>
    <div class="rows" id="rows"></div>
    <label>循环间隔 <input id="gap" type="number" min="0" step="100"> ms</label>
    <label>延迟开始 <input id="delay" type="number" min="0" step="1"> 秒</label>
    <label>运行时长 <input id="duration" type="number" min="0" step="1"> 秒</label>
    <p class="hint">延迟 0 秒立即开始；时长 0 秒持续循环。时长从正式点击开始计时，每点等待与轮间隔均计入时长。</p>
    <div class="bar"><button id="start" class="go">开始</button><button id="stop" class="stop">停止</button><button id="preview">预览坐标</button><button id="clear">清空</button></div>
    <p id="status">未运行。请重新取点；坐标不会保存。</p><p class="hint">Esc 停止 / 取消取点；Alt+S 开始或停止。等待和运行时仅显示停止按钮，切到后台自动停止。拖动标题可移动面板。</p>
  </main><button id="compactAction" hidden>展开</button></section>`;
  const $ = id => root.getElementById(id);
  const save = () => {
    GM_setValue(KEY, JSON.stringify({ gap: config.gap }));
  };
  // 清除旧版持久化坐标、时间设置和位置；仅保留循环间隔。
  save();
  const status = text => {
    $('status').textContent = text;
    if (!running) $('compactAction').title = text;
  };
  function refreshRunningHint() {
    if (!running) return;
    const now = Date.now();
    $('compactAction').title = delayDeadline > now
      ? `${Math.ceil((delayDeadline - now) / 1000)} 秒后开始`
      : Number.isFinite(runDeadline)
        ? `${Math.max(0, Math.ceil((runDeadline - now) / 1000))} 秒后停止`
        : `已点击 ${completedClicks} 次 · 点击停止`;
  }
  function scheduleHint(token) {
    if (!running || token !== generation) return;
    refreshRunningHint();
    hintTimer = setTimeout(() => scheduleHint(token), 1000);
  }
  $('compactAction').addEventListener('pointerenter', refreshRunningHint);
  const number = (value, min = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min) throw Error(`请输入不小于 ${min} 的有效数字`);
    return n;
  };
  const settings = () => {
    const next = {
      gap: number($('gap').value),
      delay: number($('delay').value),
      duration: number($('duration').value)
    };
    if (!Number.isSafeInteger(Math.ceil(next.delay * 1000)) || !Number.isSafeInteger(Math.ceil(next.duration * 1000))) {
      throw Error('时间数值过大，请缩短延迟或运行时长');
    }
    Object.assign(config, next);
    save();
  };
  function layout() {
    const compact = running || folded;
    root.querySelector('.box').classList.toggle('compact', compact);
    $('compactAction').hidden = !compact;
    $('compactAction').textContent = running ? '停止' : '展开';
    $('compactAction').classList.toggle('stop', running);
    host.style.left = `${Math.max(0, Math.min(innerWidth - (compact ? 60 : Math.min(400, innerWidth * .95)), parseFloat(host.style.left) || 0))}px`;
    host.style.top = `${Math.max(0, Math.min(innerHeight - 40, parseFloat(host.style.top) || 0))}px`;
  }
  const lock = () => {
    for (const el of root.querySelectorAll('input,select,#aim,#pick,#clear,#preview,.row button')) el.disabled = running;
    $('start').disabled = running;
  };
  function render() {
    $('rows').replaceChildren();
    config.points.forEach((p, i) => {
      const row = document.createElement('div'); row.className = 'row';
      const tag = document.createElement('small'); tag.textContent = `${i + 1}. ${p.kind === 'canvas' ? '画布' : '视口'} (${p.x},${p.y})`;
      const wait = document.createElement('input'); wait.type = 'number'; wait.min = '0'; wait.step = '100'; wait.value = p.wait; wait.title = '此点点击后等待毫秒数';
      wait.addEventListener('change', () => { try { p.wait = number(wait.value); save(); } catch (e) { wait.value = p.wait; status(e.message); } });
      row.append(tag, document.createTextNode(' 等待'), wait, document.createTextNode('ms'));
      for (const [text, action] of [['↑', () => { if (i) [config.points[i-1],config.points[i]]=[config.points[i],config.points[i-1]]; }], ['×', () => config.points.splice(i,1)]]) {
        const button = document.createElement('button'); button.textContent = text;
        button.onclick = () => { action(); save(); render(); }; row.append(button);
      }
      $('rows').append(row);
    });
    lock();
  }
  for (const key of ['gap', 'delay', 'duration']) {
    $(key).value = config[key];
    $(key).onchange = () => { try { settings(); } catch(e) { status(e.message); } };
  }
  function beginPick(dragEvent) {
    if (running || picking) return;
    picking = true;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.04);touch-action:none';
    const tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;pointer-events:none;background:#111e;color:white;padding:6px;border-radius:4px;font:13px system-ui;white-space:nowrap';
    overlay.append(tip); document.documentElement.append(overlay);
    const move = e => { tip.textContent = `⊕ ${Math.round(e.clientX)}, ${Math.round(e.clientY)} · 松开选取 · Esc取消`; tip.style.left = `${Math.min(e.clientX+14, innerWidth-260)}px`; tip.style.top = `${Math.max(0,e.clientY-34)}px`; };
    const finish = () => { overlay.remove(); picking = false; cleanupPick = null; };
    cleanupPick = finish;
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', e => {
      e.preventDefault(); e.stopImmediatePropagation();
      overlay.style.pointerEvents = 'none';
      const target = document.elementFromPoint(e.clientX, e.clientY);
      finish();
      if (!target || target === host || host.contains(target)) return status('请选取面板外的位置');
      const x = Math.round(e.clientX), y = Math.round(e.clientY);
      const canvases = [...document.querySelectorAll('canvas')];
      const canvas = target.closest('canvas');
      const p = { kind:'viewport', x, y, wait:0, width:innerWidth, height:innerHeight, scrollX, scrollY };
      if (canvas) {
        const r = canvas.getBoundingClientRect();
        if (r.width && r.height) Object.assign(p, {kind:'canvas', index:canvases.indexOf(canvas), rx:(x-r.left)/r.width, ry:(y-r.top)/r.height});
      }
      config.points.push(p); save(); render(); status(`已添加第 ${config.points.length} 个点 (${x}, ${y})`);
    }, true);
    overlay.addEventListener('pointercancel', finish);
    if (dragEvent) { overlay.setPointerCapture(dragEvent.pointerId); move(dragEvent); }
    else { tip.textContent = '点击目标位置取点 · Esc取消'; tip.style.left='20px'; tip.style.top='20px'; }
  }
  $('aim').onpointerdown = e => { if (e.button === 0) { e.preventDefault(); beginPick(e); } };
  $('pick').onclick = () => beginPick();
  function resolve(p) {
    let x=p.x, y=p.y, canvas=null;
    if (p.kind === 'canvas') {
      canvas=document.querySelectorAll('canvas')[p.index];
      if (!canvas) throw Error('原 Canvas 不存在，请重新取点');
      const r=canvas.getBoundingClientRect();
      if (!r.width || !r.height) throw Error('Canvas 不可见');
      x=r.left+r.width*p.rx; y=r.top+r.height*p.ry;
    } else if (innerWidth!==p.width || innerHeight!==p.height || scrollX!==p.scrollX || scrollY!==p.scrollY) {
      throw Error('窗口大小或滚动位置发生变化，请重新取视口坐标');
    }
    if (x<0 || y<0 || x>=innerWidth || y>=innerHeight) throw Error('坐标在可见区域外');
    const target=document.elementFromPoint(x,y);
    if (!target || target===host || host.contains(target)) throw Error('坐标被控制面板遮挡，请移动面板');
    if (canvas && target!==canvas) throw Error('Canvas 点击位置被其他元素遮挡');
    return {x,y,target};
  }
  async function clickAt(p) {
    const {x,y,target}=resolve(p);
    if (target.tagName==='IFRAME') {
      // 必须等待 iframe 完成事件派发后，才能开始此点的等待计时。
      await clickFrame(target,x,y,MODE);
      return;
    }
    dispatchAt(target,x,y,MODE);
  }
  function dispatchAt(target,x,y,mode) {
    // 油猴隔离环境的 window 可能是代理，省略可选 view，避免 Window 类型转换失败。
    const init={bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,screenX:screenX+x,screenY:screenY+y,button:0,detail:1};
    if (mode === 'touch') {
      if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') throw Error('浏览器不支持模拟 Touch，请改用 Pointer 或 Mouse');
      const touch=new Touch({identifier:1,target,clientX:x,clientY:y,pageX:x+scrollX,pageY:y+scrollY,radiusX:1,radiusY:1,force:1});
      target.dispatchEvent(new TouchEvent('touchstart',{...init,touches:[touch],targetTouches:[touch],changedTouches:[touch]}));
      target.dispatchEvent(new TouchEvent('touchend',{...init,touches:[],targetTouches:[],changedTouches:[touch]}));
      return;
    }
    const mouse=(type,buttons=0)=>target.dispatchEvent(new MouseEvent(type,{...init,buttons}));
    const pointer=(type,buttons=0)=>target.dispatchEvent(new PointerEvent(type,{...init,buttons,pointerId:1,pointerType:'mouse',isPrimary:true,pressure:buttons?0.5:0}));
    if(mode==='pointer') pointer('pointermove'); mouse('mousemove');
    if(mode==='pointer') pointer('pointerdown',1); mouse('mousedown',1);
    if(mode==='pointer') pointer('pointerup'); mouse('mouseup'); mouse('click');
  }
  function stop(message='已停止') {
    running=false; generation++; runDeadline=Infinity; delayDeadline=0;
    clearTimeout(stopTimer); stopTimer=null;
    clearTimeout(hintTimer); hintTimer=null;
    if(cancelWait) cancelWait();
    folded=false; lock(); layout(); status(message);
  }
  function wait(ms,token) {
    return new Promise(resolve => {
      let timer;
      const deadline=Date.now()+Math.max(0,ms);
      const finish=()=>{clearTimeout(timer);if(cancelWait===finish)cancelWait=null;resolve();};
      const tick=()=>{
        const remaining=deadline-Date.now();
        if(token!==generation || remaining<=0) return finish();
        timer=setTimeout(tick,Math.min(remaining,2147000000));
      };
      cancelWait=finish;
      // 即使等待为零也让出事件循环，保证停止按钮能及时响应。
      timer=setTimeout(tick,Math.min(Math.max(0,ms),2147000000));
      if(token!==generation) finish();
    });
  }
  function active(token) {
    if(!running || token!==generation) return false;
    if(document.hidden) { stop('页面进入后台，已停止'); return false; }
    if(Date.now()>=runDeadline) { stop('已达到指定运行时长，已停止'); return false; }
    return true;
  }
  function scheduleStop(token) {
    if(!Number.isFinite(runDeadline)) return;
    const tick=()=>{
      if(!running || token!==generation) return;
      const remaining=runDeadline-Date.now();
      if(remaining<=0) return stop('已达到指定运行时长，已停止');
      stopTimer=setTimeout(tick,Math.min(remaining,2147000000));
    };
    tick();
  }
  async function start() {
    if(running || picking) return;
    try {
      settings();
      if(!config.points.length) throw Error('请先添加坐标');
      if(document.hidden) throw Error('请将游戏切换到前台');
      config.points.forEach(p => { number(p.wait); resolve(p); });
    } catch(e) { status(e.message); return; }
    completedClicks=0;
    running=true; const token=++generation; lock(); layout();
    const points=config.points.map(p=>({...p}));
    const delay=config.delay, duration=config.duration, gap=config.gap;
    delayDeadline=delay>0 ? Date.now()+delay*1000 : 0;
    scheduleHint(token);
    try {
      if(delay>0) {
        status(`等待 ${delay} 秒后开始 · 点击停止可取消`);
        await wait(delay*1000,token);
      }
      if(!active(token)) return;
      delayDeadline=0;
      runDeadline=duration>0 ? Date.now()+duration*1000 : Infinity;
      refreshRunningHint();
      scheduleStop(token);
      for(let round=1; active(token); round++) {
        for(let i=0;i<points.length;i++) {
          if(!active(token)) return;
          status(`第 ${round} 轮 · 点击 ${i+1}/${points.length} · Esc 停止`);
          // 点击与等待必须顺序执行，避免下一点先于游戏收到本次输入。
          await clickAt(points[i]);
          if(running && token===generation) {
            completedClicks++;
            refreshRunningHint();
          }
          if(!active(token)) return;
          await wait(points[i].wait,token);
        }
        if(!active(token)) return;
        status(`第 ${round} 轮完成 · 等待 ${gap} ms 后继续`);
        await wait(gap,token);
      }
    } catch(e) { if(token===generation) stop(`停止：${e.message}`); }
  }
  $('start').onclick=start; $('stop').onclick=()=>stop();
  $('clear').onclick=()=>{config.points=[];save();render();status('已清空坐标');};
  $('preview').onclick=()=>{
    try {
      config.points.forEach((p,i)=>{
        const {x,y}=resolve(p), dot=document.createElement('div');
        dot.textContent=String(i+1); dot.style.cssText=`position:fixed;left:${x-12}px;top:${y-12}px;width:24px;height:24px;line-height:24px;text-align:center;border:2px solid #fff;border-radius:50%;background:#e33;color:white;z-index:2147483647;pointer-events:none;font: bold 15px/20px system-ui`;
        document.documentElement.append(dot);setTimeout(()=>dot.remove(),2000);
      }); status('已显示坐标编号，2 秒后消失；没有执行点击');
    } catch(e) {status(e.message);}
  };
  $('fold').onclick=()=>{folded=true;layout();};
  $('compactAction').onclick=()=>{
    if(running) stop();
    else { folded=false; layout(); }
  };
  const header=root.querySelector('header');
  header.onpointerdown=e=>{
    if(e.target.closest('button') || e.button!==0) return;
    const r=host.getBoundingClientRect(), dx=e.clientX-r.left,dy=e.clientY-r.top;
    header.setPointerCapture(e.pointerId);
    header.onpointermove=ev=>{host.style.left=`${Math.max(0,Math.min(innerWidth-50,ev.clientX-dx))}px`;host.style.top=`${Math.max(0,Math.min(innerHeight-35,ev.clientY-dy))}px`;};
    header.onpointerup=()=>{header.onpointermove=null;config.left=parseFloat(host.style.left);config.top=parseFloat(host.style.top);save();};
    header.onpointercancel=()=>{header.onpointermove=null;};
  };
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){if(cleanupPick) cleanupPick();stop();}
    if(e.altKey && e.code==='KeyS' && !e.repeat){e.preventDefault();running?stop():start();}
  },true);
  document.addEventListener('visibilitychange',()=>{if(document.hidden && running) stop('页面进入后台，已停止');});
  window.addEventListener('resize',layout);
  render(); layout();
})();
