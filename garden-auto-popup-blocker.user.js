// ==UserScript==
// @name         我的花园世界 - 自动推广弹窗屏蔽
// @namespace    local.garden.popup-blocker
// @version      1.0.1
// @updateURL    https://raw.githubusercontent.com/connjossy608/script/main/garden-auto-click.user.js
// @downloadURL  https://raw.githubusercontent.com/connjossy608/script/main/garden-auto-click.user.js
// @description  根据已分析的 game.js，阻止首页活动公告、每日卡包、首充及礼包促销自动弹出。
// @match        https://www.wanyiwan.top/game/xjskp*
// @match        https://www.wanyiwan.top/gameIframe*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const STATE_KEY = '__gardenAutoPopupBlocker';
  if (Object.prototype.hasOwnProperty.call(window, STATE_KEY)) return;

  const state = {
    version: '1.0.0',
    status: '等待游戏代码加载',
    patchedMethods: [],
    compileCount: 0,
    error: null
  };
  Object.defineProperty(window, STATE_KEY, {
    value: state,
    configurable: true
  });

  // 只处理上传版本中 PHomeUI 的自动推广入口。
  // 不接管通用弹窗队列，不修改存储、每日重置、购买或奖励逻辑。
  const METHODS = [
    '_checkActNotice',
    '_checkActIPNotice',
    '_checkRealUnion',
    '_checkRealMilkTea',
    '_checkTtCouponNotice',
    '_checkCjHmGiftNotice',
    '_checkShowHotSaleOnLogin',
    '_checkShowHotSaleOnOpen',
    '_checkShowHolidayGift',
    '_checkFirstRchg',
    '_checkSpringGift',
    '_checkQQCouponGift',
    '_getLvlGift',
    '_showRecommend',
    '_showEvaluate',
    '_checkVipService'
  ];

  const HOME_START = 'function(t){var e=function(e){function i()';
  const HOME_END = 't.PHomeUI=e,__reflect(e.prototype,"G.PHomeUI")';
  const log = console.info.bind(console);
  const warn = console.warn.bind(console);

  function patchGameSource(source) {
    if (typeof source !== 'string' ||
        !source.includes('_card_notice_') ||
        !source.includes(HOME_END)) return source;

    const end = source.indexOf(HOME_END);
    const start = source.lastIndexOf(HOME_START, end);
    if (start < 0) {
      state.error = '游戏代码结构变化，未修改源代码';
      warn('[花园弹窗屏蔽]', state.error);
      return source;
    }

    let home = source.slice(start, end);
    const matched = [];
    for (const name of METHODS) {
      const needle = `i.prototype.${name}=function(){`;
      const at = home.indexOf(needle);
      if (at < 0 || home.indexOf(needle, at + needle.length) >= 0) {
        state.error = `入口不匹配：${name}；未修改源代码`;
        warn('[花园弹窗屏蔽]', state.error);
        return source;
      }
      home = home.replace(needle, `${needle}return false;`);
      matched.push(name);
    }
    return {
      source: source.slice(0, start) + home + source.slice(end),
      matched
    };
  }

  // 平台在 iframe 内使用 Function(...参数名, 游戏代码)(...虚拟窗口参数)。
  // 在编译前修改已确认的入口，因此无需从外层网页访问沙箱中的 G。
  const NativeFunction = window.Function;
  function prepare(args) {
    if (!args.length || typeof args[args.length - 1] !== 'string') return { args };
    const result = patchGameSource(args[args.length - 1]);
    if (typeof result === 'string' || !result || !result.matched) return { args };
    const next = Array.from(args);
    next[next.length - 1] = result.source;
    return { args: next, matched: result.matched };
  }

  function compiled(prepared) {
    if (!prepared.matched) return;
    state.status = '游戏代码已接入';
    state.patchedMethods = prepared.matched.slice();
    state.compileCount += 1;
    state.error = null;
    log(`[花园弹窗屏蔽] 已修改 ${prepared.matched.length} 个自动推广入口。`);
  }

  window.Function = new Proxy(NativeFunction, {
    apply(target, thisArg, args) {
      const prepared = prepare(args);
      const result = Reflect.apply(target, thisArg, prepared.args);
      compiled(prepared);
      return result;
    },
    construct(target, args, newTarget) {
      const prepared = prepare(args);
      const result = Reflect.construct(target, prepared.args, newTarget);
      compiled(prepared);
      return result;
    }
  });
})();
