/**
 * game-logic.js — 游戏逻辑层
 *
 * 职责：
 *   1. 牌型评估（7选5，全部9种牌型）
 *   2. 游戏状态机（lobby → hand → result → lobby ...）
 *   3. 发牌、下注（fold/check/call/raise/allin）、边池结算
 *   4. MTT 倒计时升盲
 *   5. 带入申请与房主审批
 *   6. 个性化视图构建（viewFor 严格隔离底牌）
 *   7. 掉线自动弃牌（30秒）、操作超时（60秒 + 最后10秒倒计时）
 *
 * 依赖：Net（socket.js）
 * 暴露全局对象：Game
 */

;(function(global) {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================

  var RANKS = {14:'A',13:'K',12:'Q',11:'J',10:'10',9:'9',8:'8',7:'7',6:'6',5:'5',4:'4',3:'3',2:'2'};
  var SUITS = ['♠','♥','♦','♣'];
  var SUIT_NAMES = {'♠':'spades','♥':'hearts','♦':'diamonds','♣':'clubs'};
  var CAT_NAMES = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺'];

  var STREET_ORDER = ['preflop','flop','turn','river'];
  var STREET_NAMES = {preflop:'翻牌前',flop:'翻牌圈',turn:'转牌圈',river:'河牌圈','':'摊牌'};

  /**
   * MTT 盲注等级表（按时间倒计时）
   * dur 单位为秒
   */
  var BLIND_LEVELS = [
    {sb:10,   bb:20,   dur:1200},  // Lv1  20min
    {sb:20,   bb:40,   dur:1200},  // Lv2  20min
    {sb:30,   bb:60,   dur:1200},  // Lv3  20min
    {sb:50,   bb:100,  dur:900},   // Lv4  15min
    {sb:100,  bb:200,  dur:900},   // Lv5  15min
    {sb:300,  bb:600,  dur:900},   // Lv6  15min
    {sb:500,  bb:1000, dur:600},   // Lv7  10min
    {sb:1000, bb:2000, dur:600}    // Lv8  10min
  ];

  // 超时与断线
  var TURN_TIMEOUT_MS       = 60000;  // 操作超时 60 秒
  var TURN_COUNTDOWN_START  = 10;     // 最后 10 秒开始 UI 倒计时
  var DISCONNECT_AUTOFOLD_MS = 30000; // 掉线 30 秒自动弃牌
  var LOG_MAX = 200;

  // ============================================================
  // 工具函数
  // ============================================================

  function rand(n) { return Math.floor(Math.random() * n); }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = rand(i + 1);
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function makeDeck() {
    var d = [];
    for (var s = 0; s < 4; s++) {
      for (var r = 2; r <= 14; r++) {
        d.push({ r: r, s: SUITS[s] });
      }
    }
    return d;
  }

  function fmtCards(cs) {
    if (!cs) return '';
    return cs.map(function(c) { return RANKS[c.r] + c.s; }).join(' ');
  }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ============================================================
  // 牌型评估
  // ============================================================

  /**
   * 评估 5 张牌的牌型
   * @returns {Array} 可比较的分数数组 [category, ...tiebreakers]
   *   category: 0=高牌 1=一对 2=两对 3=三条 4=顺子 5=同花 6=葫芦 7=四条 8=同花顺
   */
  function score5(cards) {
    var r = cards.map(function(c) { return c.r; }).sort(function(a, b) { return b - a; });
    var s = cards.map(function(c) { return c.s; });
    var flush = (s[0] === s[1] && s[1] === s[2] && s[2] === s[3] && s[3] === s[4]);

    var cnt = {};
    for (var i = 0; i < r.length; i++) cnt[r[i]] = (cnt[r[i]] || 0) + 1;
    var groups = Object.keys(cnt).map(function(v) { return { v: +v, c: cnt[v] }; })
      .sort(function(a, b) { return b.c - a.c || b.v - a.v; });

    var uniq = [];
    for (var i = 0; i < r.length; i++) { if (uniq.indexOf(r[i]) < 0) uniq.push(r[i]); }

    var straight = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straight = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) straight = 5;
    }

    if (straight && flush)  return [8, straight];
    if (groups[0].c === 4)  return [7, groups[0].v, groups[1].v];
    if (groups[0].c === 3 && groups[1].c === 2) return [6, groups[0].v];
    if (flush)              return [5].concat(r);
    if (straight)           return [4, straight];
    if (groups[0].c === 3)  return [3, groups[0].v, groups[1].v, groups[2].v];
    if (groups[0].c === 2 && groups[1].c === 2) return [2, groups[0].v, groups[1].v, groups[2].v];
    if (groups[0].c === 2)  return [1, groups[0].v, groups[1].v, groups[2].v, groups[3].v];
    return [0].concat(r);
  }

  /**
   * 比较两个牌型分数，返回正数表示 a > b
   */
  function cmpScore(a, b) {
    var len = Math.max(a.length, b.length);
    for (var i = 0; i < len; i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  /**
   * 从 7 张牌中选出最佳 5 张牌型
   */
  function best7(cards) {
    var best = null;
    for (var i = 0; i < 7; i++) {
      for (var j = i + 1; j < 7; j++) {
        var hand = [];
        for (var k = 0; k < 7; k++) { if (k !== i && k !== j) hand.push(cards[k]); }
        var sc = score5(hand);
        if (!best || cmpScore(sc, best) > 0) best = sc;
      }
    }
    return best;
  }

  // ============================================================
  // 玩家工厂
  // ============================================================

  function mkPlayer(id, name, chips) {
    return {
      id: id,
      name: name,
      chips: chips,
      cards: [],
      folded: false,
      allIn: false,
      contributed: 0,
      streetBet: 0,
      hasActed: false,
      connected: true,
      sitting: false,
      left: false,
      eliminated: false,
      rebuys: 0,
      rank: null,
      inHand: false,
      lastAct: '',
      best: null  // 摊牌时缓存牌型分数
    };
  }

  function resetPlayerForHand(p) {
    p.cards = [];
    p.folded = false;
    p.allIn = false;
    p.contributed = 0;
    p.streetBet = 0;
    p.hasActed = false;
    p.lastAct = '';
    p.inHand = false;
    p.best = null;
  }

  // ============================================================
  // Game 对象
  // ============================================================

  var Game = {
    // --- 游戏状态 H ---
    H: null,

    // --- 回调（由 main.js 设置）---
    onChange: null,       // 状态变更后调用（触发广播 + 持久化）
    onTurnCountdown: null,// 操作倒计时回调 (secondsLeft)
    onWinBanner: null,    // 胜利横幅回调 (isWin, text, sub)

    // --- 内部定时器 ---
    _turnTimer: null,
    _autoFoldTimer: null,
    _mttTimer: null,
    _countdownTimer: null,

    // ============================================================
    // 初始化
    // ============================================================

    /**
     * 创建新的游戏状态
     * @param {string} code - 房间码
     * @param {string} mode - 'cash' | 'mtt'
     * @param {object} overrides - 可选的设置覆盖
     */
    newGame: function(code, mode, overrides) {
      var base = BLIND_LEVELS[0];
      var defaults = {
        mode: mode || 'cash',
        start: mode === 'mtt' ? 5000 : 2000,
        sb: base.sb,
        bb: base.bb,
        rebuy: true,
        rebuyLimit: mode === 'mtt' ? 3 : 999
      };
      if (overrides) {
        for (var k in overrides) { if (overrides.hasOwnProperty(k)) defaults[k] = overrides[k]; }
      }

      this.H = {
        code: code,
        phase: 'lobby',
        players: [],
        deck: [],
        board: [],
        dealerIdx: 0,
        street: '',
        betLevel: 0,
        minRaiseSize: 0,
        currentId: null,
        currentName: null,
        handNo: 0,
        log: [],
        result: null,
        reveal: null,
        blindLevel: 1,
        mttStartTime: null,
        mttLevelStartTime: null,
        rebuyRequests: [],
        pendingRebuy: null,
        settings: defaults
      };

      this._clearAllTimers();
    },

    /**
     * 从持久化快照恢复游戏状态
     * @param {object} savedState - _serializeState 的产物
     */
    restoreGame: function(savedState) {
      this.H = savedState;
      // 恢复时清除所有残留的定时器引用（它们已经失效）
      this.H.turnTimer = null;
      this.H.autoTimer = null;
      this.H.mttTimer = null;
      // 重建 conns 映射（由 socket.js 管理，这里置空）
      // conns 不在 H 里，由 Net.hostConns 管理

      // 如果 MTT 正在进行，重启计时器
      if (this.H.settings.mode === 'mtt' && this.H.mttLevelStartTime && this.H.phase !== 'lobby') {
        this._startMttTick();
      }

      // 如果有玩家正在操作，重启他们的超时计时器
      if (this.H.phase === 'hand' && this.H.currentId) {
        var p = this.findPlayer(this.H.currentId);
        if (p && p.connected) {
          this._startTurnTimer(p);
        }
      }
    },

    // ============================================================
    // 玩家管理
    // ============================================================

    findPlayer: function(id) {
      if (!this.H) return null;
      for (var i = 0; i < this.H.players.length; i++) {
        if (this.H.players[i].id === id) return this.H.players[i];
      }
      return null;
    },

    /**
     * 玩家加入（处理新加入和重连两种情况）
     * @returns {object} { player, isNew }
     */
    playerJoin: function(id, name) {
      var existing = this.findPlayer(id);
      if (existing) {
        // 重连：恢复连接状态
        existing.connected = true;
        // 如果之前标记为离线坐出，且不在牌局中，恢复
        if (!existing.eliminated && !existing.left) {
          if (this.H.phase === 'lobby') {
            existing.sitting = false;
          }
          // 如果在牌局中（phase === 'hand'），保持当前状态
          // folded/sitting 等不变，等断线超时处理
        }
        this.log(existing.name + ' 重新连上了');
        return { player: existing, isNew: false };
      }

      // 新玩家
      if (this._activePlayerCount() >= 8) return null; // 满员
      var p = mkPlayer(id, name || ('玩家' + (this.H.players.length + 1)), this.H.settings.start);
      this.H.players.push(p);
      this.log(p.name + ' 加入了牌桌');
      return { player: p, isNew: true };
    },

    /**
     * 玩家掉线
     */
    playerDisconnect: function(id) {
      var p = this.findPlayer(id);
      if (!p) return;
      p.connected = false;
      this.log(p.name + ' 掉线了');

      // 如果当前轮到该玩家操作，启动 30 秒自动弃牌
      if (this.H.phase === 'hand' && this.H.currentId === id) {
        this._startDisconnectAutoFold(p);
      }
      this._notifyChange();
    },

    /**
     * 玩家主动离开
     */
    playerLeave: function(id) {
      var p = this.findPlayer(id);
      if (!p) return;
      p.left = true;
      p.sitting = true;
      p.connected = false;
      this.log(p.name + ' 离开了牌桌');
      this._notifyChange();
    },

    _activePlayerCount: function() {
      var count = 0;
      for (var i = 0; i < this.H.players.length; i++) {
        if (!this.H.players[i].left) count++;
      }
      return count;
    },

    // ============================================================
    // 查询辅助
    // ============================================================

    /** 在座玩家（非坐出、非离开、非淘汰） */
    seated: function() {
      return this.H.players.filter(function(p) {
        return !p.sitting && !p.left && !p.eliminated;
      });
    },

    /** 当前手牌中可操作的玩家（未弃牌、未全下） */
    active: function() {
      return this.H.players.filter(function(p) {
        return p.inHand && !p.folded && !p.allIn;
      });
    },

    /** 当前手牌中未弃牌的玩家 */
    contenders: function() {
      return this.H.players.filter(function(p) {
        return p.inHand && !p.folded;
      });
    },

    /** 从指定位置找下一个在 parts 中的玩家索引 */
    nextIdx: function(fromIdx, parts) {
      var ps = this.H.players;
      var n = ps.length;
      var i = fromIdx;
      do {
        i = (i + 1) % n;
      } while (parts.indexOf(ps[i]) < 0 && i !== fromIdx);
      return i;
    },

    // ============================================================
    // 日志
    // ============================================================

    log: function(msg) {
      if (!this.H) return;
      this.H.log.push(msg);
      if (this.H.log.length > LOG_MAX) this.H.log.shift();
    },

    // ============================================================
    // 开局
    // ============================================================

    /**
     * 尝试开始一手牌
     * 处理重买、淘汰、MTT 计时器启动
     */
    tryStart: function() {
      var H = this.H;
      var ps = H.players;
      var self = this;

      // 更新玩家状态
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (p.left || p.eliminated) continue;
        if (!p.connected) { p.sitting = true; continue; }
        if (p.chips <= 0) {
          // MTT: 检查是否超过带入上限
          if (H.settings.mode === 'mtt') {
            if (p.rebuys >= H.settings.rebuyLimit) {
              p.eliminated = true;
              p.sitting = true;
              if (!p.rank) {
                var alive = ps.filter(function(q) { return !q.eliminated && !q.left; }).length;
                p.rank = alive + 1;
              }
              self.log(p.name + ' 已淘汰（第 ' + p.rank + ' 名）');
              continue;
            }
          }
          // 积分不足，坐出等待申请
          p.sitting = true;
        } else {
          p.sitting = false;
        }
      }

      var parts = this.seated();
      if (parts.length < 2) {
        // 不够人
        return false;
      }

      // 第一局：启动 MTT 计时器
      if (H.settings.mode === 'mtt' && H.handNo === 0) {
        this._startMttTimer();
      }

      this.startHand(parts);
      return true;
    },

    /**
     * 发牌开始一手
     */
    startHand: function(parts) {
      var H = this.H;
      H.handNo++;
      H.pendingRebuy = null;

      // 重置所有玩家
      for (var i = 0; i < H.players.length; i++) {
        resetPlayerForHand(H.players[i]);
        H.players[i].inHand = (parts.indexOf(H.players[i]) >= 0);
      }

      H.deck = shuffle(makeDeck());
      H.board = [];
      H.result = null;
      H.reveal = null;

      var ps = H.players;
      var n = ps.length;
      var idxs = parts.map(function(p) { return ps.indexOf(p); });

      // 庄家轮转
      var d;
      if (H.handNo === 1) {
        d = idxs[0];
      } else {
        d = H.dealerIdx;
        do { d = (d + 1) % n; } while (parts.indexOf(ps[d]) < 0);
      }
      H.dealerIdx = d;

      // 盲注
      var sb = H.settings.sb, bb = H.settings.bb;
      var sbI, bbI;
      if (parts.length === 2) {
        sbI = d;
        bbI = this.nextIdx(d, parts);
      } else {
        sbI = this.nextIdx(d, parts);
        bbI = this.nextIdx(sbI, parts);
      }

      this._postBlind(ps[sbI], sb, '盲注');
      this._postBlind(ps[bbI], bb, '盲注');
      H.betLevel = Math.max(bb, ps[bbI].streetBet);
      H.minRaiseSize = bb;

      // 发底牌
      H.street = 'preflop';
      H.phase = 'hand';
      H.currentId = null;
      for (var k = 0; k < 2; k++) {
        for (var j = 0; j < parts.length; j++) {
          parts[j].cards.push(H.deck.pop());
        }
      }

      this.log('—— 第 ' + H.handNo + ' 局开始' +
        (H.settings.mode === 'mtt' ? '（Level ' + H.blindLevel + '）' : '') +
        '，庄家：' + ps[d].name + ' ——');

      // 翻牌前第一个行动者
      var first = this.nextIdx(bbI, parts);
      H.currentId = ps[first].id;

      this._startTurnTimer(this.findPlayer(H.currentId));
      this._notifyChange();
    },

    _postBlind: function(p, amt, label) {
      var pay = Math.min(amt, p.chips);
      p.chips -= pay;
      p.streetBet += pay;
      p.contributed += pay;
      p.allIn = (p.chips === 0);
      p.lastAct = p.allIn ? (label + '全下') : label;
    },

    // ============================================================
    // 操作处理
    // ============================================================

    /**
     * 处理玩家操作
     * @param {string} pid - 玩家 ID
     * @param {object} a - { type: 'fold'|'check'|'call'|'raise'|'allin', amount? }
     */
    doAction: function(pid, a) {
      var H = this.H;
      if (H.phase !== 'hand') return false;

      var p = this.findPlayer(pid);
      if (!p || H.currentId !== pid || !p.inHand || p.folded || p.allIn) return false;

      // 清除定时器
      this._clearTurnTimers();

      var toCall = H.betLevel - p.streetBet;

      if (a.type === 'fold') {
        p.folded = true;
        p.lastAct = '弃牌';
        this.log(p.name + ' 弃牌');
        if (this.contenders().length === 1) {
          this._endUncontested();
          return true;
        }
      } else if (a.type === 'check') {
        if (toCall !== 0) return false;
        p.lastAct = '过牌';
        this.log(p.name + ' 过牌');
      } else if (a.type === 'call') {
        if (toCall <= 0) return false;
        var pay = Math.min(toCall, p.chips);
        this._payChips(p, pay);
        p.lastAct = p.allIn ? '全下' : '跟注';
        this.log(p.name + (p.allIn ? ' 全下跟注 ' : ' 跟注 ') + pay);
      } else if (a.type === 'raise' || a.type === 'allin') {
        var target = a.type === 'allin' ? (p.streetBet + p.chips) : Math.round(+a.amount || 0);
        if (target > p.streetBet + p.chips) target = p.streetBet + p.chips;

        if (target <= H.betLevel) {
          // 全下金额不超过当前下注，视为跟注
          var pay2 = Math.min(toCall, p.chips);
          this._payChips(p, pay2);
          p.lastAct = '全下';
          this.log(p.name + ' 全下 ' + pay2);
        } else {
          var size = target - H.betLevel;
          if (a.type === 'raise' && size < H.minRaiseSize && target < p.streetBet + p.chips) return false;
          if (size > H.minRaiseSize) H.minRaiseSize = size;
          this._payChips(p, target - p.streetBet);
          H.betLevel = target;
          p.lastAct = p.allIn ? '全下' : '加注';
          this.log(p.name + (p.allIn ? ' 全下加注到 ' : ' 加注到 ') + target);

          // 重置其他活跃玩家的 hasActed
          var self = this;
          this.active().forEach(function(q) { if (q !== p) q.hasActed = false; });
        }
      } else {
        return false;
      }

      p.hasActed = true;

      if (this._roundOver()) {
        this._endStreet();
      } else {
        this._advanceTurn();
      }
      return true;
    },

    _payChips: function(p, amt) {
      p.chips -= amt;
      p.streetBet += amt;
      p.contributed += amt;
      if (p.chips === 0) p.allIn = true;
    },

    _roundOver: function() {
      var betLevel = this.H.betLevel;
      return this.active().every(function(p) {
        return p.hasActed && p.streetBet === betLevel;
      });
    },

    _advanceTurn: function() {
      var ps = this.H.players;
      var n = ps.length;
      var i = ps.indexOf(this.findPlayer(this.H.currentId));
      do {
        i = (i + 1) % n;
      } while (!(ps[i].inHand && !ps[i].folded && !ps[i].allIn));

      this.H.currentId = ps[i].id;
      this._startTurnTimer(ps[i]);
      this._notifyChange();
    },

    // ============================================================
    // 街道推进
    // ============================================================

    _endStreet: function() {
      this._clearTurnTimers();
      var H = this.H;

      for (var i = 0; i < H.players.length; i++) {
        var p = H.players[i];
        p.streetBet = 0;
        p.hasActed = false;
        if (!p.allIn) p.lastAct = '';
      }
      H.betLevel = 0;
      H.minRaiseSize = H.settings.bb;
      H.currentId = null;

      if (this.active().length < 2) {
        this._runout();
        return;
      }
      this._dealStreet();
    },

    _dealStreet: function() {
      var H = this.H;
      if (H.street === 'preflop') {
        H.board = H.board.concat(H.deck.splice(0, 3));
        H.street = 'flop';
        this.log('翻牌：' + fmtCards(H.board.slice(0, 3)));
      } else if (H.street === 'flop') {
        H.board.push(H.deck.pop());
        H.street = 'turn';
        this.log('转牌：' + fmtCards(H.board.slice(3, 4)));
      } else if (H.street === 'turn') {
        H.board.push(H.deck.pop());
        H.street = 'river';
        this.log('河牌：' + fmtCards(H.board.slice(4, 5)));
      } else if (H.street === 'river') {
        this._showdown();
        return;
      }

      if (this.active().length < 2) {
        this._runout();
        return;
      }

      // 翻牌后从庄家左侧第一个活跃玩家开始
      var ps = H.players;
      var n = ps.length;
      var acts = this.active();
      var i = H.dealerIdx;
      do { i = (i + 1) % n; } while (acts.indexOf(ps[i]) < 0);
      H.currentId = ps[i].id;
      this._startTurnTimer(ps[i]);
      this._notifyChange();
    },

    /**
     * 全下 runout：逐张发剩余公共牌，带延迟动画
     */
    _runout: function() {
      var self = this;
      var H = this.H;
      var need = 5 - H.board.length;

      function step(k) {
        if (H.phase !== 'hand') return;
        if (k === 0) { self._showdown(); return; }
        H.board.push(H.deck.pop());
        if (H.board.length === 3) self.log('翻牌：' + fmtCards(H.board.slice(0, 3)));
        else if (H.board.length === 4) self.log('转牌：' + fmtCards(H.board.slice(3, 4)));
        else self.log('河牌：' + fmtCards(H.board.slice(4, 5)));
        self._notifyChange();
        setTimeout(function() { step(k - 1); }, 1000);
      }
      step(need);
    },

    // ============================================================
    // 结算
    // ============================================================

    _endUncontested: function() {
      this._clearTurnTimers();
      var H = this.H;
      H.phase = 'result';
      H.currentId = null;

      var w = this.contenders()[0];
      var total = H.players.reduce(function(s, p) { return s + p.contributed; }, 0);
      w.chips += total;
      H.reveal = null;
      H.result = {
        lines: ['其他人都弃牌，' + w.name + ' 赢得底池 ' + total],
        hands: [],
        winnerIds: [w.id]
      };
      this.log(H.result.lines[0]);
      this._checkPendingRebuys();
      this._notifyChange();
    },

    _showdown: function() {
      this._clearTurnTimers();
      var H = this.H;
      H.phase = 'result';
      H.currentId = null;
      H.street = '';

      var pots = this._buildPots();
      var lines = [], hands = [];
      H.reveal = {};

      var cons = this.contenders();
      var self = this;
      for (var i = 0; i < cons.length; i++) {
        var p = cons[i];
        p.best = best7(p.cards.concat(H.board));
        H.reveal[p.id] = p.cards;
      }

      var n = H.players.length;
      var winnerIds = [];

      function seatRel(p) { return (H.players.indexOf(p) - H.dealerIdx + n) % n; }

      for (var pi = 0; pi < pots.length; pi++) {
        var pot = pots[pi];
        var elig = pot.eligible.map(function(id) { return self.findPlayer(id); })
          .filter(function(p) { return p && p.inHand && !p.folded; });
        if (elig.length === 0) continue;

        var bestS = null;
        for (var j = 0; j < elig.length; j++) {
          if (!bestS || cmpScore(elig[j].best, bestS) > 0) bestS = elig[j].best;
        }
        var winners = elig.filter(function(p) { return cmpScore(p.best, bestS) === 0; })
          .sort(function(a, b) { return seatRel(a) - seatRel(b); });

        var share = Math.floor(pot.amount / winners.length);
        var rem = pot.amount - share * winners.length;
        for (var wi = 0; wi < winners.length; wi++) {
          winners[wi].chips += share + (wi < rem ? 1 : 0);
          if (winnerIds.indexOf(winners[wi].id) < 0) winnerIds.push(winners[wi].id);
        }

        var potName = pots.length > 1 ? '边池 ' + (pi + 1) + '（' + pot.amount + '）' : '底池 ' + pot.amount;
        lines.push(potName + ' → ' + winners.map(function(p) { return p.name; }).join('、') +
          ' 以【' + CAT_NAMES[bestS[0]] + '】赢得' + (winners.length > 1 ? '（平分）' : ''));
      }

      for (var ci = 0; ci < cons.length; ci++) {
        var cp = cons[ci];
        hands.push({
          name: cp.name,
          cards: cp.cards,
          cat: CAT_NAMES[cp.best[0]],
          won: winnerIds.indexOf(cp.id) >= 0
        });
      }

      H.result = { lines: lines, hands: hands, winnerIds: winnerIds };
      this.log('本局结束：' + lines.join('；'));
      this._checkPendingRebuys();
      this._notifyChange();
    },

    // ============================================================
    // 边池
    // ============================================================

    _buildPots: function() {
      var ps = this.H.players.filter(function(p) { return p.contributed > 0; });
      var levels = [];
      for (var i = 0; i < ps.length; i++) {
        if (levels.indexOf(ps[i].contributed) < 0) levels.push(ps[i].contributed);
      }
      levels.sort(function(a, b) { return a - b; });

      var prev = 0, pots = [];
      for (var li = 0; li < levels.length; li++) {
        var L = levels[li];
        var amt = 0;
        for (var j = 0; j < ps.length; j++) {
          amt += Math.max(0, Math.min(ps[j].contributed, L) - Math.min(ps[j].contributed, prev));
        }
        var elig = [];
        for (var k = 0; k < ps.length; k++) {
          if (ps[k].contributed >= L && ps[k].inHand && !ps[k].folded) elig.push(ps[k].id);
        }
        if (amt > 0 && elig.length > 0) {
          pots.push({ amount: amt, eligible: elig });
        } else if (amt > 0 && pots.length > 0) {
          pots[pots.length - 1].amount += amt;
        }
        prev = L;
      }

      // 合并 eligible 相同的相邻池
      var merged = [];
      for (var m = 0; m < pots.length; m++) {
        var last = merged[merged.length - 1];
        if (last && last.eligible.length === pots[m].eligible.length &&
            last.eligible.every(function(x, i) { return x === pots[m].eligible[i]; })) {
          last.amount += pots[m].amount;
        } else {
          merged.push({ amount: pots[m].amount, eligible: pots[m].eligible.slice() });
        }
      }
      return merged;
    },

    // ============================================================
    // 重买 / 带入审批
    // ============================================================

    _checkPendingRebuys: function() {
      var H = this.H;
      for (var i = 0; i < H.players.length; i++) {
        var p = H.players[i];
        if (!p.left && !p.eliminated && p.chips <= 0 && p.connected) {
          if (p.rebuys < H.settings.rebuyLimit) {
            H.pendingRebuy = p.id;
          }
        }
      }
    },

    /**
     * 玩家申请带入
     */
    requestRebuy: function(pid) {
      var H = this.H;
      var p = this.findPlayer(pid);
      if (!p || !H.settings.rebuy) return false;
      if (p.rebuys >= H.settings.rebuyLimit) return false;

      // 检查是否已有申请
      for (var i = 0; i < H.rebuyRequests.length; i++) {
        if (H.rebuyRequests[i].playerId === pid) return false;
      }

      H.rebuyRequests.push({ playerId: pid, name: p.name });
      this.log(p.name + ' 请求带入积分');
      this._notifyChange();
      return true;
    },

    /**
     * 房主审批带入
     * @param {string} targetId - 申请玩家 ID
     * @param {boolean} approve - true=同意, false=拒绝
     */
    reviewRebuy: function(targetId, approve) {
      var H = this.H;
      var p = this.findPlayer(targetId);

      // 移除申请
      H.rebuyRequests = H.rebuyRequests.filter(function(r) { return r.playerId !== targetId; });

      if (approve && p) {
        // 调整3约束：如果玩家离线，挂起不带入
        if (!p.connected) {
          this.log(p.name + ' 已离线，带入申请已挂起');
          this._notifyChange();
          return false;
        }
        if (p.rebuys >= H.settings.rebuyLimit) {
          this.log(p.name + ' 已达最大带入次数');
          this._notifyChange();
          return false;
        }
        p.rebuys++;
        p.chips = H.settings.start;
        p.sitting = false;
        p.eliminated = false;
        this.log(p.name + ' 带入 ' + H.settings.start + ' 积分（第 ' + p.rebuys + ' 次）');
      } else if (!approve && p) {
        this.log(p.name + ' 的带入申请被拒绝');
      }

      this._notifyChange();
      return true;
    },

    // ============================================================
    // MTT 倒计时升盲
    // ============================================================

    _startMttTimer: function() {
      this._stopMttTimer();
      var H = this.H;
      H.mttStartTime = Date.now();
      H.mttLevelStartTime = Date.now();
      H.blindLevel = 1;
      var lv = BLIND_LEVELS[0];
      H.settings.sb = lv.sb;
      H.settings.bb = lv.bb;
      this.log('🏆 锦标赛开始！Level 1：盲注 ' + lv.sb + '/' + lv.bb);
      this._startMttTick();
    },

    _startMttTick: function() {
      var self = this;
      this._stopMttTimer();
      this._mttTimer = setInterval(function() { self._mttTick(); }, 1000);
    },

    _stopMttTimer: function() {
      if (this._mttTimer) { clearInterval(this._mttTimer); this._mttTimer = null; }
    },

    _mttTick: function() {
      var H = this.H;
      if (!H || H.settings.mode !== 'mtt' || !H.mttLevelStartTime) return;

      var elapsed = (Date.now() - H.mttLevelStartTime) / 1000;
      var dur = BLIND_LEVELS[H.blindLevel - 1] ? BLIND_LEVELS[H.blindLevel - 1].dur : 900;
      var remaining = dur - elapsed;

      if (remaining <= 0) {
        if (H.blindLevel < BLIND_LEVELS.length) {
          H.blindLevel++;
          var lv = BLIND_LEVELS[H.blindLevel - 1];
          H.settings.sb = lv.sb;
          H.settings.bb = lv.bb;
          H.mttLevelStartTime = Date.now();
          this.log('⬆ 盲注升级到 Level ' + H.blindLevel + '：' + lv.sb + '/' + lv.bb);
        }
      }

      this._notifyChange();
    },

    getMttTimeLeft: function() {
      var H = this.H;
      if (!H || H.settings.mode !== 'mtt' || !H.mttLevelStartTime) return null;
      var elapsed = (Date.now() - H.mttLevelStartTime) / 1000;
      var dur = BLIND_LEVELS[H.blindLevel - 1] ? BLIND_LEVELS[H.blindLevel - 1].dur : 900;
      return Math.max(0, Math.floor(dur - elapsed));
    },

    // ============================================================
    // 定时器管理
    // ============================================================

    _startTurnTimer: function(p) {
      this._clearTurnTimers();
      if (!p || !p.connected) return;

      var self = this;
      var pid = p.id;

      // 60 秒操作超时
      this._turnTimer = setTimeout(function() {
        if (self.H.phase === 'hand' && self.H.currentId === pid) {
          var can = p.streetBet === self.H.betLevel;
          self.log(p.name + ' 超时，自动' + (can ? '过牌' : '弃牌'));
          self.doAction(pid, { type: can ? 'check' : 'fold' });
        }
      }, TURN_TIMEOUT_MS);

      // 最后 10 秒倒计时回调
      var startCountdownAt = TURN_TIMEOUT_MS - (TURN_COUNTDOWN_START * 1000);
      this._countdownTimer = setTimeout(function() {
        var secondsLeft = TURN_COUNTDOWN_START;
        var tick = setInterval(function() {
          if (!self.H || self.H.phase !== 'hand' || self.H.currentId !== pid) {
            clearInterval(tick);
            return;
          }
          self.onTurnCountdown && self.onTurnCountdown(secondsLeft);
          secondsLeft--;
          if (secondsLeft < 0) clearInterval(tick);
        }, 1000);
      }, startCountdownAt);
    },

    _startDisconnectAutoFold: function(p) {
      var self = this;
      var pid = p.id;
      clearTimeout(this._autoFoldTimer);
      this._autoFoldTimer = setTimeout(function() {
        if (self.H.phase === 'hand' && self.H.currentId === pid && !p.connected) {
          self.log(p.name + ' 掉线超时，自动弃牌');
          self.doAction(pid, { type: 'fold' });
        }
      }, DISCONNECT_AUTOFOLD_MS);
    },

    _clearTurnTimers: function() {
      clearTimeout(this._turnTimer);
      clearTimeout(this._countdownTimer);
      clearTimeout(this._autoFoldTimer);
      this._turnTimer = null;
      this._countdownTimer = null;
      this._autoFoldTimer = null;
    },

    _clearAllTimers: function() {
      this._clearTurnTimers();
      this._stopMttTimer();
    },

    // ============================================================
    // 视图构建（严格隔离底牌）
    // ============================================================

    /**
     * 为指定玩家构建个性化视图
     * 安全保证：非摊牌阶段，绝不发送其他玩家的底牌
     *
     * @param {string} pid - 目标玩家 ID
     * @returns {object} 视图对象（可安全 JSON 序列化发送）
     */
    viewFor: function(pid) {
      var H = this.H;
      if (!H) return null;

      var mp = this.findPlayer(pid);
      var cur = this.findPlayer(H.currentId);
      var isShowdown = H.phase === 'result' && H.reveal;

      // MTT 时间
      var mttTimeLeft = this.getMttTimeLeft();

      // 构建安全的玩家列表
      var players = [];
      for (var i = 0; i < H.players.length; i++) {
        var p = H.players[i];
        var cards = null;

        if (p.id === pid) {
          // 自己的底牌：始终可见
          cards = p.cards;
        } else if (isShowdown && H.reveal[p.id]) {
          // 摊牌阶段：可见被 reveal 的牌
          cards = H.reveal[p.id];
        }
        // 其他情况：cards = null（不发送）

        players.push({
          id: p.id,
          name: p.name,
          chips: p.chips,
          streetBet: p.streetBet,
          folded: p.folded,
          allIn: p.allIn,
          connected: p.connected,
          sitting: p.sitting || p.left || p.eliminated,
          left: p.left,
          eliminated: p.eliminated,
          rebuys: p.rebuys,
          rank: p.rank,
          inHand: p.inHand,
          lastAct: p.lastAct,
          seat: i,
          cards: cards  // null 或实际牌
        });
      }

      var pot = 0;
      for (var j = 0; j < H.players.length; j++) pot += H.players[j].contributed;

      return {
        phase: H.phase,
        code: H.code,
        handNo: H.handNo,
        street: H.street,
        board: H.board,
        pot: pot,
        settings: H.settings,
        isHost: pid === 'host',
        blindLevel: H.blindLevel,
        mttTimeLeft: mttTimeLeft,
        dealerId: H.players[H.dealerIdx] ? H.players[H.dealerIdx].id : null,
        currentId: H.currentId,
        currentName: cur ? cur.name : null,
        rebuyRequests: H.rebuyRequests,
        players: players,
        betLevel: H.betLevel,
        myTurn: H.phase === 'hand' && H.currentId === pid && mp && mp.connected,
        myRebuys: mp ? mp.rebuys : 0,
        toCall: mp ? Math.max(0, H.betLevel - mp.streetBet) : 0,
        minRaiseTo: mp ? Math.min(H.betLevel + H.minRaiseSize, mp.streetBet + mp.chips) : 0,
        maxRaiseTo: mp ? (mp.streetBet + mp.chips) : 0,
        result: H.result,
        log: H.log.slice(-60),
        pendingRebuy: H.pendingRebuy === pid ? pid : null,
        hasRebuyReq: mp ? H.rebuyRequests.some(function(r) { return r.playerId === pid; }) : false,
        turnCountdown: null  // 由 UI 层管理
      };
    },

    // ============================================================
    // 状态变更通知
    // ============================================================

    _notifyChange: function() {
      if (this.onChange) this.onChange(this.H);
    },

    // ============================================================
    // 设置更新
    // ============================================================

    updateSettings: function(newSettings) {
      if (!this.H) return;
      var s = this.H.settings;
      for (var k in newSettings) {
        if (newSettings.hasOwnProperty(k)) s[k] = newSettings[k];
      }
      this._notifyChange();
    },

    // ============================================================
    // 常量暴露
    // ============================================================

    BLIND_LEVELS: BLIND_LEVELS,
    CAT_NAMES: CAT_NAMES,
    STREET_NAMES: STREET_NAMES,
    RANKS: RANKS,
    DISCONNECT_AUTOFOLD_MS: DISCONNECT_AUTOFOLD_MS,
    TURN_TIMEOUT_MS: TURN_TIMEOUT_MS,
    TURN_COUNTDOWN_START: TURN_COUNTDOWN_START
  };

  // 暴露到全局
  global.Game = Game;

})(window);
