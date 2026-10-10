/**
 * socket.js — 网络层
 * 
 * 职责：
 *   1. PeerJS 连接管理（多信令服务器 fallback）
 *   2. Host 端：接收客户端连接、广播状态
 *   3. Client 端：连接房主、发送动作
 *   4. 断线重连（指数退避，最多 50 次）
 *   5. Host 状态持久化到 localStorage，刷新后可恢复
 * 
 * 暴露全局对象：Net
 */

;(function(global) {
  'use strict';

  // ============================================================
  // 常量与配置
  // ============================================================

  /**
   * PeerJS 信令服务器列表（按优先级排列）
   * 默认使用 PeerJS 官方，失败时依次尝试备用
   */
  var SIGNALING_SERVERS = [
    { host: '0.peerjs.com', port: 443, path: '/', secure: true },
    { host: 'peerjs-server.onrender.com', port: 443, path: '/', secure: true },
    // 可追加自建服务器
  ];

  var STORAGE_KEY = 'dxp_host_state_v2';  // Host 状态持久化 key
  var PID_KEY     = 'dxp_pid';            // 玩家持久 ID key
  var NAME_KEY    = 'dxp_name';           // 昵称记忆 key
  var PEER_PREFIX = 'dxpk-';              // 房间 peer ID 前缀

  var RECONNECT_MAX_RETRIES = 50;
  var RECONNECT_BASE_DELAY  = 2000;   // 首次重试 2 秒
  var RECONNECT_MAX_DELAY   = 60000;  // 最大重试间隔 60 秒
  var DISCONNECT_GRACE_MS   = 5000;   // 5 秒内不弹重连 overlay（区分闪断和真断线）

  // ============================================================
  // 工具函数
  // ============================================================

  function generateId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function generateRoomCode(len) {
    len = len || 5;
    var chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    var code = '';
    for (var i = 0; i < len; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * 指数退避计算
   * delay = min(baseDelay * 2^attempt + jitter, maxDelay)
   */
  function backoffDelay(attempt) {
    var jitter = Math.random() * 500;
    var delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt) + jitter;
    return Math.min(delay, RECONNECT_MAX_DELAY);
  }

  // ============================================================
  // Net 对象 — 核心网络管理器
  // ============================================================

  var Net = {
    // --- 身份 ---
    me:       { id: null, name: '', isHost: false },
    peer:     null,
    roomCode: '',

    // --- Host 端 ---
    hostConns: {},       // { playerId: DataConnection }
    hostCallbacks: {},   // 事件回调

    // --- Client 端 ---
    hostConn:       null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    _graceTimer:    null,
    _wasConnected:  false,

    // --- 持久化 ---
    _saveDebounce: null,

    // ============================================================
    // 初始化
    // ============================================================

    init: function() {
      // 恢复持久 ID
      var pid = sessionStorage.getItem(PID_KEY);
      if (!pid) {
        pid = generateId();
        sessionStorage.setItem(PID_KEY, pid);
      }
      this.me.id = pid;

      // 恢复昵称
      var savedName = localStorage.getItem(NAME_KEY);
      if (savedName) this.me.name = savedName;
    },

    saveName: function(name) {
      this.me.name = name;
      localStorage.setItem(NAME_KEY, name);
    },

    // ============================================================
    // 信令服务器选择
    // ============================================================

    /**
     * 尝试用多个信令服务器创建 Peer 实例
     * @param {string} peerId - 指定 peer ID（Host 用），null 则随机（Client）
     * @param {function} onSuccess - 成功回调 (peer)
     * @param {function} onError - 全部失败回调 (error)
     */
    _createPeerWithFallback: function(peerId, onSuccess, onError) {
      var self = this;
      var idx = 0;

      function tryNext() {
        if (idx >= SIGNALING_SERVERS.length) {
          onError(new Error('所有信令服务器均不可用'));
          return;
        }

        var server = SIGNALING_SERVERS[idx];
        idx++;

        var opts = {
          host:   server.host,
          port:   server.port,
          path:   server.path,
          secure: server.secure,
          debug:  0
        };

        try {
          var peer = peerId ? new Peer(peerId, opts) : new Peer(opts);
        } catch (e) {
          tryNext();
          return;
        }

        var settled = false;
        var timeout = setTimeout(function() {
          if (!settled) {
            settled = true;
            try { peer.destroy(); } catch(e) {}
            tryNext();
          }
        }, 8000); // 8 秒超时

        peer.on('open', function() {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          onSuccess(peer);
        });

        peer.on('error', function(err) {
          if (settled) return;
          // 只有连接阶段错误才 fallback
          if (err && (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-closed')) {
            settled = true;
            clearTimeout(timeout);
            try { peer.destroy(); } catch(e) {}
            tryNext();
          }
          // unavailable-id / peer-unavailable 等不 fallback
        });
      }

      tryNext();
    },

    // ============================================================
    // Host 端 API
    // ============================================================

    /**
     * 创建房间
     * @param {string} name - 房主昵称
     * @param {string} mode - 'cash' | 'mtt'
     * @param {function} callbacks - { onOpen, onPlayerJoin, onPlayerData, onPlayerLeave, onError }
     * @returns {string} roomCode
     */
    createRoom: function(name, mode, callbacks) {
      var self = this;
      this.me.name = name;
      this.me.isHost = true;
      this.saveName(name);
      this.hostCallbacks = callbacks || {};

      var code = generateRoomCode();
      this.roomCode = code;
      var peerId = PEER_PREFIX + code;

      callbacks.onOpen && callbacks.onOpen('connecting');

      this._createPeerWithFallback(peerId, function(peer) {
        self.peer = peer;

        // 监听客户端连接
        peer.on('connection', function(conn) {
          self._handleHostConnection(conn);
        });

        // PeerJS 自身断线重连
        peer.on('disconnected', function() {
          try { peer.reconnect(); } catch(e) {}
        });

        peer.on('error', function(err) {
          if (err && err.type === 'unavailable-id') {
            // 房间码冲突，换一个
            code = generateRoomCode();
            self.roomCode = code;
            try { peer.destroy(); } catch(e) {}
            self.createRoom(name, mode, callbacks);
          } else {
            callbacks.onError && callbacks.onError(err);
          }
        });

        callbacks.onOpen && callbacks.onOpen('ready', code);
      }, function(err) {
        callbacks.onError && callbacks.onError(err);
      });

      return code;
    },

    /**
     * Host 处理新客户端连接
     */
    _handleHostConnection: function(conn) {
      var self = this;

      conn.on('open', function() {
        // 等待 join 消息
      });

      conn.on('data', function(data) {
        if (!conn._playerId) {
          // 首条消息必须是 join
          if (data && data.t === 'join') {
            conn._playerId = data.id;
            conn._playerName = (data.name || '玩家').slice(0, 12);
            self.hostConns[data.id] = conn;
            self.hostCallbacks.onPlayerJoin && self.hostCallbacks.onPlayerJoin({
              id: data.id,
              name: conn._playerName,
              conn: conn
            });
          }
          return;
        }

        // 后续消息转发给回调
        self.hostCallbacks.onPlayerData && self.hostCallbacks.onPlayerData(conn._playerId, data);
      });

      conn.on('close', function() {
        if (conn._playerId) {
          self.hostCallbacks.onPlayerLeave && self.hostCallbacks.onPlayerLeave(conn._playerId);
          delete self.hostConns[conn._playerId];
        }
      });

      conn.on('error', function() {
        // 静默处理
      });
    },

    /**
     * Host 向指定玩家发送消息
     */
    hostSend: function(playerId, data) {
      var conn = this.hostConns[playerId];
      if (conn) {
        try { conn.send(data); } catch(e) {}
      }
    },

    /**
     * Host 向所有已连接玩家广播
     */
    hostBroadcast: function(data) {
      var ids = Object.keys(this.hostConns);
      for (var i = 0; i < ids.length; i++) {
        this.hostSend(ids[i], data);
      }
    },

    /**
     * Host 广播个性化视图（由外部传入 viewBuilder 函数）
     * @param {Array} players - 玩家列表
     * @param {function} viewBuilder - (playerId) => viewObject
     * @param {function} localRender - 房主本地渲染回调
     */
    hostBroadcastViews: function(players, viewBuilder, localRender) {
      for (var i = 0; i < players.length; i++) {
        var p = players[i];
        var view = viewBuilder(p.id);
        if (p.id === 'host') {
          localRender && localRender(view);
        } else {
          this.hostSend(p.id, { t: 'view', v: view });
        }
      }
    },

    // ============================================================
    // Host 状态持久化（localStorage）
    // ============================================================

    /**
     * 安全序列化 Host 状态（剥离不可序列化字段）
     * 必须去掉：conns（DataConnection 实例，循环引用）、
     *           turnTimer/autoTimer/mttTimer（setTimeout ID）、
     *           所有 function 引用
     * @param {object} H - 完整的游戏状态对象
     * @returns {object} 纯数据快照
     */
    _serializeState: function(H) {
      if (!H) return null;
      // 深拷贝，排除不可序列化字段
      var STRIP_KEYS = ['conns', 'turnTimer', 'autoTimer', 'mttTimer', '_saveDebounce'];
      var snapshot = {};
      var keys = Object.keys(H);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (STRIP_KEYS.indexOf(k) >= 0) continue;
        var val = H[k];
        if (typeof val === 'function') continue;
        snapshot[k] = val; // players 数组是纯数据对象，可以直接引用
      }
      // 但 players 里的 cards 等是纯 {r,s} 对象，安全
      // 做一次 JSON 往返确保没有隐藏引用
      try {
        return JSON.parse(JSON.stringify(snapshot));
      } catch(e) {
        console.warn('[Net] _serializeState deep clone failed, shallow copy used');
        return snapshot;
      }
    },

    /**
     * 保存 Host 游戏状态到 localStorage
     * 防抖：100ms 内多次调用只存一次
     * @param {object} gameState - H 对象（内部自动剥离不可序列化字段）
     */
    saveHostState: function(gameState) {
      var self = this;
      clearTimeout(this._saveDebounce);
      this._saveDebounce = setTimeout(function() {
        try {
          var safeState = self._serializeState(gameState);
          var data = {
            savedAt: Date.now(),
            roomCode: self.roomCode,
            state: safeState
          };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch(e) {
          console.warn('[Net] saveHostState failed:', e);
        }
      }, 100);
    },

    /**
     * 恢复 Host 游戏状态
     * @returns {object|null} 恢复的状态，或 null
     */
    loadHostState: function() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        var data = JSON.parse(raw);
        // 24 小时过期
        if (Date.now() - data.savedAt > 24 * 60 * 60 * 1000) {
          localStorage.removeItem(STORAGE_KEY);
          return null;
        }
        return data;
      } catch(e) {
        return null;
      }
    },

    /**
     * 清除已保存的 Host 状态
     */
    clearHostState: function() {
      localStorage.removeItem(STORAGE_KEY);
    },

    /**
     * Host 刷新页面后恢复房间
     * @param {object} savedData - loadHostState() 返回的数据
     * @param {function} callbacks - 同 createRoom
     */
    resumeRoom: function(savedData, callbacks) {
      var self = this;
      this.roomCode = savedData.roomCode;
      this.me.isHost = true;
      this.hostCallbacks = callbacks || {};

      var peerId = PEER_PREFIX + this.roomCode;

      callbacks.onOpen && callbacks.onOpen('recovering');

      this._createPeerWithFallback(peerId, function(peer) {
        self.peer = peer;

        peer.on('connection', function(conn) {
          self._handleHostConnection(conn);
        });

        peer.on('disconnected', function() {
          try { peer.reconnect(); } catch(e) {}
        });

        peer.on('error', function(err) {
          if (err && err.type === 'unavailable-id') {
            // 房间码已被占用（可能有旧连接），等一下重试
            setTimeout(function() {
              try { peer.destroy(); } catch(e) {}
              self.resumeRoom(savedData, callbacks);
            }, 3000);
          } else {
            callbacks.onError && callbacks.onError(err);
          }
        });

        callbacks.onOpen && callbacks.onOpen('recovered', self.roomCode);
      }, function(err) {
        callbacks.onError && callbacks.onError(err);
      });
    },

    // ============================================================
    // Client 端 API
    // ============================================================

    /**
     * 加入房间
     * @param {string} code - 房间码
     * @param {string} name - 玩家昵称
     * @param {function} callbacks - { onConnected, onData, onDisconnected, onFull, onError }
     */
    joinRoom: function(code, name, callbacks) {
      var self = this;
      this.roomCode = code;
      this.me.name = name;
      this.me.isHost = false;
      this.saveName(name);
      this.reconnectAttempt = 0;
      this._wasConnected = false;

      callbacks = callbacks || {};

      this._doConnect(code, name, callbacks);
    },

    /**
     * 实际连接逻辑（可被重连复用）
     */
    _doConnect: function(code, name, callbacks) {
      var self = this;
      var peerId = PEER_PREFIX + code;

      this._createPeerWithFallback(null, function(peer) {
        self.peer = peer;

        var conn = peer.connect(peerId, { reliable: true });
        self.hostConn = conn;

        conn.on('open', function() {
          conn.send({ t: 'join', id: self.me.id, name: name });
          self.reconnectAttempt = 0;
          self._wasConnected = true;
          clearTimeout(self._graceTimer);
          callbacks.onConnected && callbacks.onConnected(code);
        });

        conn.on('data', function(data) {
          if (data && data.t === 'view') {
            callbacks.onData && callbacks.onData(data.v);
          } else if (data && data.t === 'welcome') {
            callbacks.onConnected && callbacks.onConnected(data.code || code);
          } else if (data && data.t === 'full') {
            callbacks.onFull && callbacks.onFull();
          }
        });

        conn.on('close', function() {
          self._handleDisconnect(callbacks);
        });

        conn.on('error', function() {
          self._handleDisconnect(callbacks);
        });

        // PeerJS 自身错误
        peer.on('error', function(err) {
          if (err && err.type === 'peer-unavailable') {
            if (self.reconnectAttempt === 0) {
              callbacks.onError && callbacks.onError('peer-unavailable');
            } else {
              self._handleDisconnect(callbacks);
            }
          }
        });

      }, function(err) {
        callbacks.onError && callbacks.onError('no-server');
      });
    },

    /**
     * 处理断线（区分闪断 vs 真断线）
     */
    _handleDisconnect: function(callbacks) {
      var self = this;
      if (!this._wasConnected) return;

      // 5 秒宽限期：不立即弹 overlay
      clearTimeout(this._graceTimer);
      this._graceTimer = setTimeout(function() {
        callbacks.onDisconnected && callbacks.onDisconnected(self.reconnectAttempt + 1);
      }, DISCONNECT_GRACE_MS);

      // 开始指数退避重连
      this._scheduleReconnect(callbacks);
    },

    /**
     * 指数退避重连
     */
    _scheduleReconnect: function(callbacks) {
      var self = this;
      if (this.reconnectAttempt >= RECONNECT_MAX_RETRIES) {
        clearTimeout(this._graceTimer);
        callbacks.onDisconnected && callbacks.onDisconnected(-1); // -1 = 彻底放弃
        return;
      }

      var delay = backoffDelay(this.reconnectAttempt);
      this.reconnectAttempt++;

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(function() {
        // 销毁旧 peer
        try { if (self.peer) self.peer.destroy(); } catch(e) {}
        self.peer = null;
        self.hostConn = null;

        // 重新连接
        self._doConnect(self.roomCode, self.me.name, callbacks);
      }, delay);
    },

    /**
     * Client 发送动作给 Host
     */
    sendAction: function(actionData) {
      if (this.me.isHost) {
        // 本地直接调用 Game.doAction，不走网络
        return;
      }
      if (this.hostConn) {
        try { this.hostConn.send({ t: 'act', a: actionData }); } catch(e) {}
      }
    },

    /**
     * Client 发送任意消息给 Host
     */
    sendToHost: function(data) {
      if (this.hostConn) {
        try { this.hostConn.send(data); } catch(e) {}
      }
    },

    /**
     * 主动断开连接（区分于意外断线）
     */
    disconnect: function() {
      this._wasConnected = false;
      clearTimeout(this.reconnectTimer);
      clearTimeout(this._graceTimer);
      this.reconnectAttempt = 0;

      if (this.hostConn) {
        try { this.hostConn.send({ t: 'leave' }); } catch(e) {}
        try { this.hostConn.close(); } catch(e) {}
        this.hostConn = null;
      }
      if (this.peer) {
        try { this.peer.destroy(); } catch(e) {}
        this.peer = null;
      }
    },

    /**
     * Host 销毁房间
     */
    destroyRoom: function() {
      this.hostConns = {};
      this.hostCallbacks = {};
      this.clearHostState();
      if (this.peer) {
        try { this.peer.destroy(); } catch(e) {}
        this.peer = null;
      }
    },

    // ============================================================
    // 工具 API
    // ============================================================

    getRoomUrl: function() {
      return location.origin + location.pathname + '?room=' + this.roomCode;
    },

    getMyId: function() {
      return this.me.id;
    },

    isHost: function() {
      return this.me.isHost;
    }
  };

  // 初始化
  Net.init();

  // 暴露到全局
  global.Net = Net;

})(window);
