/**
 * ui.js — 渲染层
 *
 * 职责：
 *   1. 根据 V（view 对象）渲染 DOM — 只读 V，绝不修改
 *   2. 绑定用户点击事件 → 只调用 Net.sendAction / Net.sendToHost / App 入口
 *   3. 卡牌翻牌动画（will-change + backface-visibility 防闪烁）
 *   4. 胜利/失败横幅（z-index 层级正确）
 *   5. 移动端优化（48px 按钮、大滑块、topbar 滚动）
 *   6. 带入申请入口（弹窗关闭后仍可重新打开）
 *
 * 依赖：Game（game-logic.js）、Net（socket.js）
 * 暴露全局对象：UI
 */

;(function(global) {
  'use strict';

  // ============================================================
  // DOM 快捷工具
  // ============================================================

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ============================================================
  // 内部状态（UI 层自有，不涉及游戏数据）
  // ============================================================

  var _lastBoardLen = 0;       // 上次的公共牌数量，用于检测新增
  var _lastMyCardKey = '';     // 上次自己的底牌 key，用于检测翻牌
  var _lastResultHandNo = 0;   // 上次结果的手牌号，用于触发胜利横幅
  var _raisePanelOpen = false; // 加注面板是否展开
  var _logPanelOpen = false;   // 日志面板是否展开
  var _winBannerTimer = null;  // 胜利横幅自动消失定时器
  var _rebuyDialogDismissed = false; // 用户是否主动关闭了带入弹窗

  // ============================================================
  // 卡牌 HTML 生成
  // ============================================================

  /**
   * 生成一张卡牌的 HTML
   * @param {object|null} c - {r, s} 或 null（牌背）
   * @param {boolean} small - 是否小尺寸
   * @param {boolean} faceDown - 是否牌背朝上（用于翻牌动画起始态）
   */
  function cardHTML(c, small, faceDown) {
    var sz = small ? ' sm' : '';
    if (!c) {
      return '<div class="card-wrap"><div class="card back' + sz + '">'
        + '<div class="card-inner"><div class="card-front"></div><div class="card-back"></div></div>'
        + '</div></div>';
    }
    var col = (c.s === '♥' || c.s === '♦') ? '#d33' : '#151515';
    var flipCls = faceDown ? ' flip' : '';
    return '<div class="card-wrap"><div class="card' + sz + flipCls + '">'
      + '<div class="card-inner">'
      + '<div class="card-front" style="color:' + col + '"><span class="r">' + Game.RANKS[c.r] + '</span><span class="s">' + c.s + '</span></div>'
      + '<div class="card-back"></div>'
      + '</div></div></div>';
  }

  // ============================================================
  // 屏幕切换
  // ============================================================

  function showScreen(id) {
    var screens = ['scrHome', 'scrLobby', 'scrGame'];
    for (var i = 0; i < screens.length; i++) {
      var el = $(screens[i]);
      if (el) el.className = 'screen' + (screens[i] === id ? ' on' : '');
    }
  }

  function hideOverlay() {
    var el = $('overlay');
    if (el) el.className = '';
  }

  function showOverlay(html) {
    var card = $('ovCard');
    var ov = $('overlay');
    if (card) card.innerHTML = html;
    if (ov) ov.className = 'on';
  }

  function showToast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._tm);
    t._tm = setTimeout(function() { t.style.display = 'none'; }, 2600);
  }

  // ============================================================
  // 胜利/失败横幅
  // ============================================================

  function showWinBanner(isWin, text, sub) {
    var el = $('winBanner');
    if (!el) return;
    el.className = 'win-banner' + (isWin ? '' : ' lost');
    el.innerHTML = '<h2>' + (isWin ? '🎉 ' + esc(text) : '💔 ' + esc(text)) + '</h2>'
      + (sub ? '<p>' + esc(sub) + '</p>' : '');
    el.style.display = 'block';
    // 清除上一次定时器
    clearTimeout(_winBannerTimer);
    _winBannerTimer = setTimeout(function() {
      el.classList.add('fadeout');
      setTimeout(function() { el.style.display = 'none'; el.className = ''; }, 500);
    }, 2500);
  }

  // ============================================================
  // 动画触发（GPU 加速，可快速重置）
  // ============================================================

  /**
   * 公共牌入场动画
   * 使用 CSS class 触发，动画结束后移除 class（可重复触发）
   */
  function triggerBoardAnim() {
    var bc = $('boardCards');
    if (!bc || !bc.children) return;
    var kids = bc.children;
    for (var i = _lastBoardLen; i < kids.length; i++) {
      if (kids[i] && kids[i].classList) {
        // 先移除再添加，确保快速重发时动画可重置
        kids[i].classList.remove('board-enter');
        void kids[i].offsetWidth; // 强制 reflow，重置动画
        kids[i].classList.add('board-enter');
      }
    }
    _lastBoardLen = kids.length;
  }

  /**
   * 自己底牌翻牌动画
   * 卡牌初始渲染为牌背朝上（带 .flip class），
   * 此函数移除 .flip 使卡牌翻转到正面
   */
  function triggerMyFlip() {
    var mc = $('myCards');
    if (!mc || !mc.querySelectorAll) return;
    var cards = mc.querySelectorAll('.card');
    if (!cards) return;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] && cards[i].classList) {
        // 卡牌已经带 .flip（牌背朝上），移除即翻到正面
        cards[i].classList.remove('flip');
      }
    }
  }

  // ============================================================
  // Toast
  // ============================================================

  // (已在上面定义)

  // ============================================================
  // 主渲染入口
  // ============================================================

  /**
   * 渲染客户端视图
   * 这是唯一的渲染入口，由 Net.onData 或 Game.onChange 调用
   * @param {object} v - viewFor(pid) 返回的视图对象
   */
  function render(v) {
    if (!v) return;

    if (v.phase === 'lobby') {
      showScreen('scrLobby');
      renderLobby(v);
    } else {
      showScreen('scrGame');
      renderGame(v);
    }
  }

  // ============================================================
  // 大厅渲染
  // ============================================================

  function renderLobby(v) {
    var codeEl = $('lbCode');
    var urlEl = $('lbUrl');
    var modeTag = $('lbModeTag');
    var countEl = $('lbCount');
    var playersEl = $('lbPlayers');
    var settingsEl = $('lbSettings');
    var bottomEl = $('lbBottom');

    if (codeEl) codeEl.textContent = v.code;
    if (urlEl) urlEl.value = Net.getRoomUrl();

    var modeText = v.settings.mode === 'mtt' ? '🏆 锦标赛' : '🎯 积分娱乐';
    if (modeTag) {
      modeTag.textContent = '（' + modeText + '）';
      modeTag.style.color = v.settings.mode === 'mtt' ? '#e8c66a' : '#9db3a5';
    }

    var online = v.players.filter(function(p) { return !p.left && !p.eliminated && p.connected; }).length;
    var total = v.players.filter(function(p) { return !p.left; }).length;
    if (countEl) countEl.textContent = total;

    // 玩家列表
    var phtml = '';
    for (var i = 0; i < v.players.length; i++) {
      var p = v.players[i];
      if (p.left) continue;
      var cls = 'pchip' + (p.connected ? '' : ' off') + (p.eliminated ? ' out' : '');
      phtml += '<div class="' + cls + '">'
        + (p.id === 'host' ? '👑 ' : '')
        + esc(p.name)
        + ' <b>' + p.chips + '</b>'
        + (p.eliminated ? '（已淘汰）' : p.connected ? '' : '（离线）')
        + (p.id === Net.getMyId() ? '（我）' : '')
        + (v.settings.mode === 'mtt' && p.rebuys > 0 ? ' · ' + p.rebuys + '/' + (v.settings.rebuyLimit || 3) + '次带入' : '')
        + '</div>';
    }
    if (playersEl) playersEl.innerHTML = phtml || '<span class="muted">还没有玩家</span>';

    // 设置
    var s = v.settings;
    if (v.isHost) {
      var setsHtml = '<b style="font-size:14px;">牌局设置</b><br>'
        + '<label>起始积分 <input type="number" id="setStart" value="' + s.start + '" min="1000" step="1000"></label>'
        + '<label>小盲 <input type="number" id="setSb" value="' + s.sb + '" min="1"></label>'
        + '<label>大盲 <input type="number" id="setBb" value="' + s.bb + '" min="2"></label><br>';
      if (s.mode === 'cash') {
        setsHtml += '<span class="muted">积分娱乐模式：输光后可申请带入，房主审批</span>';
      } else {
        setsHtml += '<label>最大带入次数 <input type="number" id="setRebuyLimit" value="' + (s.rebuyLimit || 3) + '" min="1" max="10" style="width:60px;"></label>'
          + '<span class="muted"> · 盲注按倒计时自动升级</span>';
      }
      if (settingsEl) settingsEl.innerHTML = setsHtml;

      // 带入申请
      var reqHtml = '';
      if (v.rebuyRequests && v.rebuyRequests.length > 0) {
        reqHtml = '<div style="margin:8px 0;"><b style="color:var(--gold);">📋 带入申请</b>';
        for (var ri = 0; ri < v.rebuyRequests.length; ri++) {
          var r = v.rebuyRequests[ri];
          var rp = v.players.find(function(pp) { return pp.id === r.playerId; });
          reqHtml += '<div class="rebuy-req">' + esc(r.name) + '（当前 '
            + (rp ? rp.chips : 0) + ' 分，已带入 ' + (rp ? rp.rebuys : 0) + ' 次）请求带入'
            + '<div class="btns">'
            + '<button class="btn-gold rebuy-btn" data-action="approve-rebuy" data-target="' + r.playerId + '">✓ 同意</button>'
            + '<button class="btn-red rebuy-btn" data-action="reject-rebuy" data-target="' + r.playerId + '">✗ 拒绝</button>'
            + '</div></div>';
        }
        reqHtml += '</div>';
      }

      if (bottomEl) {
        bottomEl.innerHTML = reqHtml
          + '<button class="btn-gold" style="width:100%;padding:14px;font-size:17px;" data-action="host-start" '
          + (online < 2 ? 'disabled' : '')
          + '>开始游戏' + (online < 2 ? '（至少 2 人在线）' : '（' + online + ' 人就位）') + '</button>';
      }
    } else {
      var desc = s.mode === 'mtt'
        ? '锦标赛 · 起始积分 ' + s.start + ' · 盲注 ' + s.sb + '/' + s.bb + ' · 最多带入 ' + (s.rebuyLimit || 3) + ' 次 · 盲注倒计时升级'
        : '积分娱乐 · 起始积分 ' + s.start + ' · 盲注 ' + s.sb + '/' + s.bb + ' · 输光后申请带入';
      if (settingsEl) settingsEl.innerHTML = '<b style="font-size:14px;">牌局设置</b><br><span class="muted">' + desc + '</span>';
      if (bottomEl) bottomEl.innerHTML = '<div class="wait">等待房主开局…<br><button class="btn-blue" data-action="ping-start" style="margin-top:8px;">提醒房主开始</button></div>';
    }
  }

  // ============================================================
  // 游戏界面渲染
  // ============================================================

  function renderGame(v) {
    renderTopbar(v);
    renderOpponents(v);
    renderBoard(v);
    renderMyArea(v);
    renderActionBar(v);
    renderLevelBar(v);

    // 胜利横幅
    checkWinBanner(v);

    // 弹窗
    if (v.phase === 'result') {
      renderResult(v);
    } else if (v.pendingRebuy && v.pendingRebuy === Net.getMyId()) {
      renderRebuyDialog(v);
    } else {
      // 非结果/非带入阶段，如果 overlay 是这两种内容就关掉
      var ov = $('overlay');
      if (ov && ov.className === 'on') {
        var card = $('ovCard');
        if (card && (card.innerHTML.indexOf('局结束') >= 0 || card.innerHTML.indexOf('积分已用尽') >= 0 || card.innerHTML.indexOf('申请带入') >= 0)) {
          hideOverlay();
        }
      }
    }

    // 带入申请按钮（非弹窗状态下，给输光玩家一个常驻入口）
    renderRebuyEntryButton(v);
  }

  function renderTopbar(v) {
    var codeEl = $('gCode');
    var handEl = $('gHand');
    var blindsEl = $('gBlinds');
    var levelWrap = $('gLevelWrap');
    var levelEl = $('gLevel');
    var phaseEl = $('gPhase');

    if (codeEl) codeEl.textContent = v.code;
    if (handEl) handEl.textContent = v.handNo;
    if (blindsEl) blindsEl.textContent = v.settings.sb + '/' + v.settings.bb;

    var isMtt = v.settings.mode === 'mtt';
    if (levelWrap) levelWrap.style.display = isMtt ? '' : 'none';
    if (levelEl && isMtt) levelEl.textContent = v.blindLevel;

    var streetName = Game.STREET_NAMES[v.street] || '';
    if (phaseEl) phaseEl.textContent = v.phase === 'result' ? '本局结束' : streetName;
  }

  function renderLevelBar(v) {
    var lb = $('levelBar');
    if (!lb) return;
    var isMtt = v.settings.mode === 'mtt';
    if (isMtt && v.mttTimeLeft !== null && v.mttTimeLeft !== undefined) {
      lb.style.display = '';
      var nextLv = v.blindLevel < Game.BLIND_LEVELS.length ? Game.BLIND_LEVELS[v.blindLevel] : null;
      lb.innerHTML = 'Lv.' + v.blindLevel + ' ' + fmtTime(v.mttTimeLeft)
        + (nextLv ? ' <span class="muted">→ ' + nextLv.sb + '/' + nextLv.bb + '</span>' : ' <span class="muted">MAX</span>');
    } else {
      lb.style.display = 'none';
    }
  }

  function renderOpponents(v) {
    var el = $('opponents');
    if (!el) return;

    var ps = v.players;
    var n = ps.length;
    var myIdx = 0;
    for (var i = 0; i < n; i++) { if (ps[i].id === Net.getMyId()) { myIdx = i; break; } }

    var html = '';
    for (var k = 1; k < n; k++) {
      var p = ps[(myIdx + k) % n];
      if (p.left) continue;

      var isTurn = v.currentId === p.id && v.phase === 'hand';
      var isWinner = v.result && v.result.winnerIds && v.result.winnerIds.indexOf(p.id) >= 0;
      var cls = 'opp' + (isTurn ? ' turn' : '') + (p.folded ? ' fold' : '') + (isWinner ? ' winner-flash' : '');

      var badges = '';
      if (p.id === v.dealerId && v.phase !== 'lobby') badges += '<span class="badge">D</span>';
      if (!p.connected && !p.eliminated) badges += '<span class="badge off">离线</span>';
      if (p.eliminated) badges += '<span class="badge eliminated">淘汰</span>';

      var cards = '';
      if (p.cards && p.cards.length) {
        for (var ci = 0; ci < p.cards.length; ci++) cards += cardHTML(p.cards[ci], true);
      } else if (p.inHand && !p.folded && v.phase === 'hand') {
        cards += cardHTML(null, true) + cardHTML(null, true);
      }

      var st = p.eliminated ? '已淘汰（#' + p.rank + ')'
        : p.sitting ? '观战'
        : p.folded ? '弃牌'
        : (isTurn ? '思考中…' : (p.lastAct || ''));
      if (p.allIn && !p.folded) st = '全下';

      html += '<div class="' + cls + '">' + badges
        + '<div class="nm">' + esc(p.name) + '</div>'
        + '<div class="ch">' + p.chips + '</div>'
        + '<div class="bet">' + (p.streetBet > 0 ? '下注 ' + p.streetBet : '') + '</div>'
        + '<div class="cards">' + cards + '</div>'
        + '<div class="st">' + st + '</div></div>';
    }
    el.innerHTML = html;
  }

  function renderBoard(v) {
    var bc = $('boardCards');
    if (!bc) return;

    var newBoard = '';
    for (var i = 0; i < v.board.length; i++) newBoard += cardHTML(v.board[i], false);

    if (v.board.length > _lastBoardLen && _lastBoardLen > 0) {
      bc.innerHTML = newBoard;
      // 延迟一帧触发动画，确保 DOM 已更新
      requestAnimationFrame(triggerBoardAnim);
    } else if (v.board.length === 0) {
      bc.innerHTML = '<span class="muted" style="align-self:center;">等待发牌</span>';
      _lastBoardLen = 0;
    } else {
      bc.innerHTML = newBoard;
      _lastBoardLen = v.board.length;
    }

    var sl = $('streetLine');
    if (sl) sl.textContent = v.phase === 'hand' ? (Game.STREET_NAMES[v.street] || '') : '';

    var pl = $('potLine');
    if (pl) pl.textContent = '底池  ' + v.pot;
  }

  function renderMyArea(v) {
    var mc = $('myCards');
    var info = $('myInfo');
    if (!mc || !info) return;

    var ps = v.players;
    var mp = null;
    for (var i = 0; i < ps.length; i++) { if (ps[i].id === Net.getMyId()) { mp = ps[i]; break; } }

    // 底牌 — 渲染为牌背朝上（faceDown=true），然后翻牌动画揭示
    var myCardsHtml = '';
    var myCardKey = '';
    if (mp && mp.cards && mp.cards.length) {
      for (var ci = 0; ci < mp.cards.length; ci++) myCardsHtml += cardHTML(mp.cards[ci], false, true);
      myCardKey = mp.cards.map(function(c) { return c.r + '' + c.s; }).join(',');
    }

    mc.innerHTML = myCardsHtml;
    // 新牌翻牌动画：只要底牌变化就触发（包括首次发牌）
    if (myCardKey !== _lastMyCardKey && myCardKey !== '') {
      // 延迟一帧确保 DOM 已渲染，然后移除 .flip 翻到正面
      requestAnimationFrame(triggerMyFlip);
    }
    _lastMyCardKey = myCardKey;

    // 信息区
    var html = '';
    if (mp) {
      var isMtt = v.settings.mode === 'mtt';
      html = '<div><b>' + esc(mp.name) + '</b> · 积分 <b>' + mp.chips + '</b>';
      if (isMtt) html += ' · 带入 ' + mp.rebuys + '/' + (v.settings.rebuyLimit || 3);
      if (mp.eliminated) html += ' · <span style="color:var(--red);">已淘汰</span>';
      else if (mp.sitting) html += ' · <span class="muted">观战</span>';
      html += '</div>';
      if (v.myTurn) html += '<div class="turn-tag">轮到你了！</div>';
      else if (v.phase === 'hand' && v.currentName) html += '<div class="muted">等待 ' + esc(v.currentName) + ' 操作…</div>';
    }
    info.innerHTML = html;
  }

  // ============================================================
  // 操作栏
  // ============================================================

  function renderActionBar(v) {
    var bar = $('actionBar');
    if (!bar) return;

    var mp = null;
    for (var i = 0; i < v.players.length; i++) { if (v.players[i].id === Net.getMyId()) { mp = v.players[i]; break; } }

    if (!v.myTurn || !mp || v.phase !== 'hand') {
      bar.className = '';
      bar.innerHTML = '';
      _raisePanelOpen = false;
      return;
    }

    var toCall = v.toCall;
    var canRaise = v.maxRaiseTo > v.betLevel;
    var rMin = v.minRaiseTo;
    var rMax = v.maxRaiseTo;

    var html = '<div class="act-row">'
      + '<button class="btn-red act-btn" data-action="fold">弃牌</button>';
    if (toCall <= 0) {
      html += '<button class="btn-gray act-btn" data-action="check">过牌</button>';
    } else {
      html += '<button class="btn-blue act-btn" data-action="call">跟注 ' + Math.min(toCall, mp.chips) + '</button>';
    }
    if (canRaise && rMax > rMin) {
      html += '<button class="btn-gold act-btn" data-action="toggle-raise">加注</button>';
    }
    html += '<button class="btn-purple act-btn" data-action="allin">全下 ' + rMax + '</button>'
      + '</div>';

    // 加注面板
    html += '<div id="raisePanel" class="' + (_raisePanelOpen ? 'on' : '') + '">'
      + '<div class="raise-display">加注到 <b id="raiseAmt">' + rMin + '</b>'
      + (toCall > 0 ? ' <span class="muted">（需跟 ' + toCall + '）</span>' : '')
      + '</div>'
      + '<div class="raise-row">'
      + '<button class="raise-step-btn" data-action="raise-minus">−</button>'
      + '<input type="range" id="raiseSlider" min="' + rMin + '" max="' + rMax + '" step="' + v.settings.bb + '" value="' + rMin + '">'
      + '<button class="raise-step-btn" data-action="raise-plus">+</button>'
      + '</div>'
      + '<div class="quick">'
      + '<button data-action="quick-raise" data-kind="min">最小</button>'
      + '<button data-action="quick-raise" data-kind="half">½ 池</button>'
      + '<button data-action="quick-raise" data-kind="pot">底池</button>'
      + '<button data-action="quick-raise" data-kind="max">全下</button>'
      + '</div>'
      + '<div class="act-row">'
      + '<button class="btn-gray" data-action="cancel-raise">取消</button>'
      + '<button class="btn-gold" data-action="confirm-raise">确认加注</button>'
      + '</div></div>';

    bar.innerHTML = html;
    bar.className = 'on';
  }

  // ============================================================
  // 操作栏交互（只调用 Net.sendAction，不修改 V）
  // ============================================================

  function handleActionBarAction(action, target, kind) {
    var V = global._currentView; // 从 App 层获取最新视图
    if (!V) return;

    switch (action) {
      case 'fold':
        Net.sendAction({ type: 'fold' });
        break;
      case 'check':
        Net.sendAction({ type: 'check' });
        break;
      case 'call':
        Net.sendAction({ type: 'call' });
        break;
      case 'allin':
        Net.sendAction({ type: 'allin' });
        break;
      case 'toggle-raise':
        _raisePanelOpen = !_raisePanelOpen;
        var rp = $('raisePanel');
        if (rp) rp.className = _raisePanelOpen ? 'on' : '';
        break;
      case 'cancel-raise':
        _raisePanelOpen = false;
        var rp2 = $('raisePanel');
        if (rp2) rp2.className = '';
        break;
      case 'confirm-raise':
        var slider = $('raiseSlider');
        if (!slider) return;
        var val = +slider.value;
        if (val >= V.maxRaiseTo) {
          Net.sendAction({ type: 'allin' });
        } else {
          Net.sendAction({ type: 'raise', amount: val });
        }
        break;
      case 'raise-minus':
        adjustSlider(-V.settings.bb);
        break;
      case 'raise-plus':
        adjustSlider(V.settings.bb);
        break;
      case 'quick-raise':
        quickRaise(kind, V);
        break;
    }
  }

  function adjustSlider(delta) {
    var slider = $('raiseSlider');
    var amtEl = $('raiseAmt');
    if (!slider) return;
    var newVal = Math.max(+slider.min, Math.min(+slider.max, +slider.value + delta));
    slider.value = newVal;
    if (amtEl) amtEl.textContent = newVal;
  }

  function quickRaise(kind, V) {
    var slider = $('raiseSlider');
    var amtEl = $('raiseAmt');
    if (!slider || !V) return;

    var bb = V.settings.bb;
    var rMin = V.minRaiseTo;
    var rMax = V.maxRaiseTo;
    var val = rMin;

    if (kind === 'min') val = rMin;
    else if (kind === 'max') val = rMax;
    else {
      var potAfter = V.pot + V.toCall;
      var f = kind === 'half' ? 0.5 : 1;
      val = V.betLevel + Math.round(potAfter * f / bb) * bb;
    }
    val = Math.max(rMin, Math.min(rMax, val));
    slider.value = val;
    if (amtEl) amtEl.textContent = val;
  }

  // ============================================================
  // 胜利横幅检测
  // ============================================================

  function checkWinBanner(v) {
    if (v.phase === 'result' && v.result && v.handNo !== _lastResultHandNo) {
      _lastResultHandNo = v.handNo;
      if (v.result.winnerIds && v.result.winnerIds.indexOf(Net.getMyId()) >= 0) {
        showWinBanner(true, '你赢了！', v.result.lines[0] || '');
      } else if (v.result.winnerIds && v.result.winnerIds.length > 0) {
        var winners = v.players.filter(function(p) { return v.result.winnerIds.indexOf(p.id) >= 0; });
        var names = winners.map(function(p) { return p.name; }).join('、');
        showWinBanner(false, names + ' 赢了', v.result.lines[0] || '');
      }
    }
    if (v.phase !== 'result') _lastResultHandNo = 0;
  }

  // ============================================================
  // 结果弹窗
  // ============================================================

  function renderResult(v) {
    var html = '<h2>第 ' + v.handNo + ' 局结束</h2>';
    if (v.result) {
      for (var i = 0; i < v.result.lines.length; i++) {
        html += '<div class="res-line" style="color:var(--gold);">' + esc(v.result.lines[i]) + '</div>';
      }
      if (v.result.hands && v.result.hands.length) {
        html += '<div class="reveal-row">';
        for (var hi = 0; hi < v.result.hands.length; hi++) {
          var h = v.result.hands[hi];
          var cls = 'reveal-item' + (h.won ? ' win' : '');
          html += '<div class="' + cls + '">' + (h.won ? '👑 ' : '') + esc(h.name)
            + '<br><span class="muted">' + h.cat + '</span><div class="cards">';
          for (var ci = 0; ci < h.cards.length; ci++) html += cardHTML(h.cards[ci], true);
          html += '</div></div>';
        }
        html += '</div>';
      }
    }

    // MTT 排名
    if (v.settings.mode === 'mtt') {
      var ranked = v.players.filter(function(p) { return p.eliminated || p.chips > 0; })
        .filter(function(p) { return !p.left; })
        .sort(function(a, b) {
          if (a.eliminated && !b.eliminated) return 1;
          if (!a.eliminated && b.eliminated) return -1;
          if (a.eliminated && b.eliminated) return (a.rank || 99) - (b.rank || 99);
          return b.chips - a.chips;
        });
      html += '<div style="margin-top:8px;"><b>排名</b><ol class="rank-list">';
      for (var ri = 0; ri < ranked.length; ri++) {
        var rp = ranked[ri];
        var label = rp.eliminated ? '（已淘汰 #' + rp.rank + '）' : ('积分 ' + rp.chips);
        html += '<li class="' + (rp.eliminated ? 'out' : '') + '">' + esc(rp.name) + ' — ' + label + '</li>';
      }
      html += '</ol></div>';
    } else {
      html += '<div style="margin-top:6px;" class="muted">';
      for (var pi = 0; pi < v.players.length; pi++) {
        var pp = v.players[pi];
        if (pp.left) continue;
        html += esc(pp.name) + '：' + pp.chips + (pp.sitting ? '（观战）' : '') + ' ';
      }
      html += '</div>';
    }

    // 带入申请（房主可见）
    if (v.isHost && v.rebuyRequests && v.rebuyRequests.length > 0) {
      html += '<div style="margin-top:10px;"><b style="color:var(--gold);">📋 带入申请</b>';
      for (var rri = 0; rri < v.rebuyRequests.length; rri++) {
        var rr = v.rebuyRequests[rri];
        var rrp = v.players.find(function(qq) { return qq.id === rr.playerId; });
        html += '<div class="rebuy-req">' + esc(rr.name) + '（' + (rrp ? rrp.chips : 0) + ' 分，已带入 ' + (rrp ? rrp.rebuys : 0) + ' 次）'
          + '<div class="btns">'
          + '<button class="btn-gold rebuy-btn" data-action="approve-rebuy" data-target="' + rr.playerId + '">✓ 同意</button>'
          + '<button class="btn-red rebuy-btn" data-action="reject-rebuy" data-target="' + rr.playerId + '">✗ 拒绝</button>'
          + '</div></div>';
      }
      html += '</div>';
    }

    // 非房主的带入按钮
    if (v.pendingRebuy && v.pendingRebuy === Net.getMyId() && !v.isHost) {
      if (!v.hasRebuyReq) {
        html += '<button class="btn-gold" style="width:100%;margin-top:10px;padding:13px;font-size:16px;" data-action="request-rebuy">申请带入 ' + v.settings.start + ' 积分</button>';
      } else {
        html += '<div class="muted" style="margin-top:8px;">⏳ 已发送带入申请，等待房主审批</div>';
      }
    }

    if (v.isHost) {
      html += '<button class="btn-gold" style="width:100%;margin-top:12px;padding:13px;font-size:16px;" data-action="host-next">下一局</button>';
    } else {
      html += '<div class="muted" style="margin-top:12px;">等待房主发下一局…</div>';
    }
    html += '<div style="margin-top:8px;"><button class="btn-gray" data-action="close-overlay">收起（继续观桌）</button></div>';
    showOverlay(html);
  }

  // ============================================================
  // 带入弹窗
  // ============================================================

  function renderRebuyDialog(v) {
    // 如果用户主动关闭了弹窗，不再自动弹出
    if (_rebuyDialogDismissed) return;

    var used = v.myRebuys || 0;
    var limit = v.settings.rebuyLimit || 3;

    if (v.hasRebuyReq) {
      showOverlay('<h2>⏳ 等待房主审批</h2><p>你的带入申请已发送，等待房主同意。</p>'
        + '<button class="btn-gray" data-action="close-overlay">知道了</button>');
      return;
    }

    if (used >= limit) {
      showOverlay('<h2>💀 积分已用尽</h2><p>你已用完所有 ' + limit + ' 次带入机会。</p>'
        + '<p class="muted">你已被淘汰，但可以继续观战。</p>'
        + '<button class="btn-gray" data-action="close-overlay">观战</button>');
      return;
    }

    showOverlay('<h2>💰 积分已用尽</h2>'
      + '<p>你本局输光了所有积分。</p>'
      + '<p>是否向房主申请第 <b style="color:var(--gold);">' + (used + 1) + '</b> 次带入？</p>'
      + '<p class="muted">带入 ' + v.settings.start + ' 积分（剩余 ' + (limit - used - 1) + ' 次机会）</p>'
      + '<div style="display:flex;gap:8px;margin-top:12px;">'
      + '<button class="btn-gray" style="flex:1;" data-action="skip-rebuy">不了，观战</button>'
      + '<button class="btn-gold" style="flex:1;" data-action="request-rebuy">申请带入</button>'
      + '</div>');
  }

  /**
   * 常驻带入入口（弹窗关闭后仍可点击）
   * 渲染在 myInfo 下方
   */
  function renderRebuyEntryButton(v) {
    var info = $('myInfo');
    if (!info) return;

    // 只在以下情况显示：玩家未淘汰、筹码为 0、不在牌局中、没有待处理申请
    var mp = null;
    for (var i = 0; i < v.players.length; i++) {
      if (v.players[i].id === Net.getMyId()) { mp = v.players[i]; break; }
    }
    if (!mp) return;
    if (mp.eliminated || mp.chips > 0 || v.phase === 'hand') return;
    if (v.hasRebuyReq) {
      // 已有申请待审批，显示状态
      if (!info.innerHTML.match(/等待审批/)) {
        info.innerHTML += '<div class="muted" style="margin-top:4px;">⏳ 带入申请等待审批中</div>';
      }
      return;
    }
    var used = mp.rebuys || 0;
    var limit = v.settings.rebuyLimit || 3;
    if (used >= limit) return; // 已用尽

    // 检查是否已经有这个按钮了
    if (info.querySelector('.rebuy-entry-btn')) return;

    var btn = document.createElement('button');
    btn.className = 'btn-gold rebuy-entry-btn';
    btn.style.cssText = 'margin-top:6px;padding:8px 16px;font-size:13px;';
    btn.setAttribute('data-action', 'open-rebuy-dialog');
    btn.textContent = '申请带入 ' + v.settings.start + ' 积分';
    btn.addEventListener('click', function() {
      _rebuyDialogDismissed = false;
      renderRebuyDialog(v);
    });
    info.appendChild(btn);
  }

  // ============================================================
  // 日志面板
  // ============================================================

  function toggleLog() {
    var lp = $('logPanel');
    if (!lp) return;
    _logPanelOpen = !_logPanelOpen;
    if (_logPanelOpen) {
      var V = global._currentView;
      var html = '<b style="color:var(--gold);">牌局日志</b>';
      if (V && V.log) {
        for (var i = V.log.length - 1; i >= 0; i--) {
          html += '<div>' + esc(V.log[i]) + '</div>';
        }
      }
      lp.innerHTML = html;
      lp.className = 'on';
    } else {
      lp.className = '';
    }
  }

  // ============================================================
  // 全局事件委托
  // ============================================================

  function initEvents() {
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;

      // 禁用按钮不响应点击
      if (btn.disabled || btn.getAttribute('disabled') !== null) return;

      var action = btn.getAttribute('data-action');
      var target = btn.getAttribute('data-target');
      var kind = btn.getAttribute('data-kind');

      switch (action) {
        // --- 操作栏 ---
        case 'fold':
        case 'check':
        case 'call':
        case 'allin':
          handleActionBarAction(action);
          break;
        case 'toggle-raise':
        case 'cancel-raise':
        case 'confirm-raise':
        case 'raise-minus':
        case 'raise-plus':
          handleActionBarAction(action);
          break;
        case 'quick-raise':
          handleActionBarAction(action, null, kind);
          break;

        // --- 大厅 ---
        case 'host-start':
          if (global.App && global.App.hostStart) global.App.hostStart();
          break;
        case 'ping-start':
          Net.sendToHost({ t: 'startReq' });
          showToast('已提醒房主');
          break;

        // --- 游戏 ---
        case 'host-next':
          hideOverlay();
          if (global.App && global.App.hostNext) global.App.hostNext();
          break;
        case 'close-overlay':
          hideOverlay();
          _rebuyDialogDismissed = true;
          break;

        // --- 带入 ---
        case 'request-rebuy':
          if (Net.isHost()) {
            if (global.App && global.App.approveRebuy) global.App.approveRebuy(Net.getMyId());
          } else {
            Net.sendToHost({ t: 'rebuyRequest' });
            showToast('已发送带入申请');
            hideOverlay();
            _rebuyDialogDismissed = true;
          }
          break;
        case 'skip-rebuy':
          hideOverlay();
          _rebuyDialogDismissed = true;
          break;
        case 'approve-rebuy':
          if (global.App && global.App.approveRebuy) global.App.approveRebuy(target);
          break;
        case 'reject-rebuy':
          if (global.App && global.App.rejectRebuy) global.App.rejectRebuy(target);
          break;
        case 'open-rebuy-dialog':
          _rebuyDialogDismissed = false;
          if (global._currentView) renderRebuyDialog(global._currentView);
          break;

        // --- 日志 ---
        case 'toggle-log':
          toggleLog();
          break;
      }
    });

    // 滑块实时更新
    document.addEventListener('input', function(e) {
      if (e.target && e.target.id === 'raiseSlider') {
        var amtEl = $('raiseAmt');
        if (amtEl) amtEl.textContent = e.target.value;
      }
    });
  }

  // ============================================================
  // 滑块绑定（实时更新数值显示）
  // ============================================================

  // (已在 initEvents 中通过事件委托处理)

  // ============================================================
  // 首页初始化
  // ============================================================

  function initHome() {
    var nameInput = $('inpName');
    var savedName = localStorage.getItem('dxp_name');
    if (savedName && nameInput) nameInput.value = savedName;

    // URL 参数：被邀请者隐藏创建房间
    var m = location.search.match(/room=([A-Za-z0-9]{4,6})/);
    var hostSection = $('hostOnlySection');
    if (m) {
      var codeInput = $('inpCode');
      if (codeInput) codeInput.value = m[1].toUpperCase();
      if (hostSection) hostSection.style.display = 'none';
      if (nameInput && savedName) nameInput.focus();
    } else {
      if (nameInput) nameInput.focus();
    }
  }

  // ============================================================
  // 复制链接
  // ============================================================

  function copyLink() {
    var inp = $('lbUrl');
    if (!inp) return;
    inp.select();
    inp.setSelectionRange(0, 999);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch(e) {}
    if (navigator.clipboard) {
      navigator.clipboard.writeText(inp.value).then(
        function() { showToast('链接已复制，去微信粘贴吧'); },
        function() { showToast(ok ? '链接已复制' : '请长按输入框手动复制'); }
      );
    } else {
      showToast(ok ? '链接已复制' : '请长按输入框手动复制');
    }
  }

  // ============================================================
  // 暴露 API
  // ============================================================

  var UI = {
    render: render,
    showToast: showToast,
    showOverlay: showOverlay,
    hideOverlay: hideOverlay,
    toggleLog: toggleLog,
    copyLink: copyLink,
    initHome: initHome,
    initEvents: initEvents,

    // 重置 UI 状态（用于新游戏/新房间）
    reset: function() {
      _lastBoardLen = 0;
      _lastMyCardKey = '';
      _lastResultHandNo = 0;
      _raisePanelOpen = false;
      _logPanelOpen = false;
      _rebuyDialogDismissed = false;
      clearTimeout(_winBannerTimer);
    }
  };

  global.UI = UI;

})(window);
