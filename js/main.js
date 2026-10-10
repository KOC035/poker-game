/**
 * main.js — 入口胶水层
 *
 * 唯一职责：
 *   1. DOM 加载完毕后初始化 Net / Game / UI
 *   2. 把 UI.render 注册到 Net.onData（客户端）和 Game.onChange（房主）
 *   3. 处理首页的创建/加入按钮事件
 *   4. 处理 Host 状态恢复（刷新页面后自动恢复房间）
 *   5. beforeunload 提示
 *
 * 不包含任何游戏逻辑或 DOM 渲染逻辑。
 */

;(function(global) {
  'use strict';

  // ============================================================
  // App 对象
  // ============================================================

  var App = {

    // 当前最新的客户端视图（供 UI 层读取）
    currentView: null,

    // ============================================================
    // 初始化
    // ============================================================

    init: function() {
      // 1. 初始化 UI 事件（全局事件委托）
      UI.initEvents();

      // 2. 初始化首页（恢复昵称、检测 URL 参数）
      UI.initHome();

      // 3. 绑定首页按钮
      this._bindHomeButtons();

      // 4. 绑定日志按钮
      var logBtn = document.getElementById('btnLog');
      if (logBtn) {
        logBtn.addEventListener('click', function() { UI.toggleLog(); });
      }

      // 5. 绑定复制链接按钮
      var copyBtn = document.getElementById('btnCopy');
      if (copyBtn) {
        copyBtn.addEventListener('click', function() { UI.copyLink(); });
      }

      // 6. 绑定退出房间按钮
      var leaveBtn = document.getElementById('btnLeave');
      if (leaveBtn) {
        leaveBtn.addEventListener('click', function() {
          Net.disconnect();
          location.reload();
        });
      }

      // 7. 检查是否需要恢复 Host 状态（刷新页面）
      this._checkHostRecovery();

      // 8. 检查 URL 参数是否自动加入房间
      this._checkAutoJoin();

      // 9. beforeunload 提示
      var self = this;
      window.addEventListener('beforeunload', function(e) {
        if (Net.isHost() && Game.H && Game.H.phase !== 'lobby') {
          e.preventDefault();
          e.returnValue = '牌局进行中，离开将解散房间';
          return e.returnValue;
        }
      });
    },

    // ============================================================
    // 首页按钮绑定
    // ============================================================

    _bindHomeButtons: function() {
      var self = this;

      var createBtn = document.getElementById('btnCreate');
      if (createBtn) {
        createBtn.addEventListener('click', function() { self._onCreateRoom(); });
      }

      var joinBtn = document.getElementById('btnJoin');
      if (joinBtn) {
        joinBtn.addEventListener('click', function() { self._onJoinRoom(); });
      }
    },

    // ============================================================
    // 创建房间
    // ============================================================

    _onCreateRoom: function() {
      var nameInput = document.getElementById('inpName');
      var name = nameInput ? nameInput.value.trim() : '';
      if (!name) {
        UI.showToast('请输入昵称');
        return;
      }

      var modeRadio = document.querySelector('input[name="mode"]:checked');
      var mode = modeRadio ? modeRadio.value : 'cash';

      var callbacks = {
        onOpen: function(status, code) {
          if (status === 'ready') {
            UI.showToast('房间已创建，把链接发给朋友吧');
          }
        },
        onPlayerJoin: function(info) {
          var result = Game.playerJoin(info.id, info.name);
          if (result) {
            // 发送 welcome 消息
            Net.hostSend(info.id, { t: 'welcome', code: Net.roomCode, settings: Game.H.settings });
          }
        },
        onPlayerData: function(pid, data) {
          this._handleHostMessage(pid, data);
        }.bind(this),
        onPlayerLeave: function(pid) {
          Game.playerLeave(pid);
        },
        onError: function(err) {
          UI.showToast('创建失败：' + (err && err.message || '未知错误'));
        }
      };

      var code = Net.createRoom(name, mode, callbacks);

      // 初始化游戏状态
      Game.newGame(code, mode);

      // 注册 Game.onChange → 广播视图 + 持久化
      var self = this;
      Game.onChange = function() {
        self._broadcastViews();
        Net.saveHostState(Game.H);
      };

      // 切换到等待状态（大厅）
      // 第一次广播会在 tryStart 时触发
    },

    // ============================================================
    // 加入房间
    // ============================================================

    _onJoinRoom: function() {
      var nameInput = document.getElementById('inpName');
      var codeInput = document.getElementById('inpCode');
      var name = nameInput ? nameInput.value.trim() : '';
      var code = codeInput ? codeInput.value.trim().toUpperCase() : '';

      if (!name) { UI.showToast('请输入昵称'); return; }
      if (!code) { UI.showToast('请输入房间码'); return; }

      this._joinRoom(code, name);
    },

    _joinRoom: function(code, name) {
      var self = this;
      var callbacks = {
        onConnected: function(roomCode) {
          UI.showToast('已连接到房间 ' + roomCode);
        },
        onData: function(view) {
          self.currentView = view;
          global._currentView = view; // 供 UI 层读取
          UI.render(view);
        },
        onDisconnected: function(attempt) {
          if (attempt === -1) {
            UI.showOverlay(
              '<h2>无法重连</h2>'
              + '<p>房主可能已关闭房间。</p>'
              + '<button class="btn-gray" onclick="location.reload()">返回首页</button>'
            );
          } else {
            UI.showOverlay(
              '<h2>与房间断开</h2>'
              + '<p class="muted">正在尝试重新连接…（第 ' + attempt + ' 次）</p>'
            );
          }
        },
        onFull: function() {
          UI.showOverlay(
            '<h2>房间已满</h2>'
            + '<p>这桌最多 8 人。</p>'
            + '<button class="btn-gray" onclick="location.reload()">返回</button>'
          );
        },
        onError: function(type) {
          if (type === 'peer-unavailable') {
            UI.showToast('房间不存在，或房主已离线');
          } else {
            UI.showToast('连接失败');
          }
        }
      };

      Net.joinRoom(code, name, callbacks);
    },

    // ============================================================
    // Host 消息处理
    // ============================================================

    _handleHostMessage: function(pid, data) {
      if (!data || !data.t) return;

      switch (data.t) {
        case 'act':
          if (data.a) Game.doAction(pid, data.a);
          break;

        case 'startReq':
          if (Game.H && Game.H.phase === 'lobby') {
            this.hostStart();
          }
          break;

        case 'nextReq':
          if (Game.H && Game.H.phase === 'result') {
            this.hostNext();
          }
          break;

        case 'rebuyRequest':
          Game.requestRebuy(pid);
          break;

        case 'leave':
          Game.playerLeave(pid);
          break;
      }
    },

    // ============================================================
    // 广播视图（Host 端）
    // ============================================================

    _broadcastViews: function() {
      if (!Game.H) return;

      var players = Game.H.players;
      var self = this;

      // 使用 Net.hostBroadcastViews，传入 viewBuilder 和 localRender
      Net.hostBroadcastViews(
        players,
        function(pid) { return Game.viewFor(pid); },
        function(hostView) {
          self.currentView = hostView;
          global._currentView = hostView;
          UI.render(hostView);
        }
      );
    },

    // ============================================================
    // Host 操作入口（由 UI 事件调用）
    // ============================================================

    hostStart: function() {
      // 从 UI 读取设置（如果大厅有输入框）
      var startEl = document.getElementById('setStart');
      var sbEl = document.getElementById('setSb');
      var bbEl = document.getElementById('setBb');
      var rebuyEl = document.getElementById('setRebuy');
      var rebuyLimitEl = document.getElementById('setRebuyLimit');

      if (startEl && sbEl && bbEl) {
        var newSettings = {
          start: Math.max(1000, +startEl.value || 2000),
          sb: Math.max(1, +sbEl.value || 10),
          bb: Math.max(2, +bbEl.value || 20)
        };
        if (newSettings.bb <= newSettings.sb) newSettings.bb = newSettings.sb * 2;

        if (Game.H.settings.mode === 'cash') {
          newSettings.rebuy = !!(rebuyEl && rebuyEl.checked);
        } else {
          newSettings.rebuyLimit = rebuyLimitEl ? Math.max(1, Math.min(10, +rebuyLimitEl.value || 3)) : 3;
          newSettings.rebuy = true;
        }

        Game.updateSettings(newSettings);

        // 第一局：重置所有玩家筹码
        if (Game.H.handNo === 0) {
          for (var i = 0; i < Game.H.players.length; i++) {
            var p = Game.H.players[i];
            if (!p.left && !p.eliminated) p.chips = newSettings.start;
          }
        }
      }

      var started = Game.tryStart();
      if (!started) {
        UI.showToast('至少需要 2 名未淘汰玩家才能开局');
      }
    },

    hostNext: function() {
      UI.hideOverlay();
      Game.tryStart();
    },

    approveRebuy: function(targetId) {
      Game.reviewRebuy(targetId, true);
    },

    rejectRebuy: function(targetId) {
      Game.reviewRebuy(targetId, false);
    },

    // ============================================================
    // Host 状态恢复
    // ============================================================

    _checkHostRecovery: function() {
      var saved = Net.loadHostState();
      if (!saved || !saved.state) return;

      // 只在房主本人访问时恢复（通过 localStorage 中的标记判断）
      // 简单策略：如果当前没有 ?room= 参数，且 saved 数据存在，则恢复
      var m = location.search.match(/room=([A-Za-z0-9]{4,6})/);
      if (m) return; // 被邀请者，不恢复

      // 恢复游戏状态
      Game.restoreGame(saved.state);

      var self = this;
      var callbacks = {
        onOpen: function(status, code) {
          if (status === 'recovered') {
            UI.showToast('房间已恢复，房间码：' + code);
          }
        },
        onPlayerJoin: function(info) {
          var result = Game.playerJoin(info.id, info.name);
          if (result) {
            Net.hostSend(info.id, { t: 'welcome', code: Net.roomCode, settings: Game.H.settings });
            // 如果在牌局中，立即发送当前视图
            if (Game.H.phase !== 'lobby') {
              var view = Game.viewFor(info.id);
              Net.hostSend(info.id, { t: 'view', v: view });
            }
          }
        },
        onPlayerData: function(pid, data) {
          self._handleHostMessage(pid, data);
        },
        onPlayerLeave: function(pid) {
          Game.playerLeave(pid);
        },
        onError: function(err) {
          UI.showToast('恢复失败：' + (err && err.message || '未知错误'));
        }
      };

      Net.resumeRoom(saved, callbacks);

      // 注册 onChange
      Game.onChange = function() {
        self._broadcastViews();
        Net.saveHostState(Game.H);
      };
    },

    // ============================================================
    // URL 参数自动加入
    // ============================================================

    _checkAutoJoin: function() {
      // 如果有 ?room= 参数，且用户已输入昵称，自动加入
      // （昵称从 localStorage 恢复，UI.initHome 已处理）
      // 这里不自动触发加入，让用户确认昵称后点击"加入房间"
    }
  };

  // ============================================================
  // DOM 加载后启动
  // ============================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { App.init(); });
  } else {
    App.init();
  }

  // 暴露到全局（供 UI 层调用 App.hostStart 等）
  global.App = App;

})(window);
