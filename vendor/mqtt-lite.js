/**
 * mqtt-lite.js — 极简 MQTT 3.1.1 客户端（仅 QoS 0），ES5 + 原生 WebSocket
 *
 * 为什么不用现成的 mqtt.js：
 *   - mqtt@5 用了可选链 / 类字段 / BigInt 等语法级新特性，Android 微信的 X5 老内核
 *     解析时会直接抛 SyntaxError，导致整个文件不可用（与当初 CDN 挂掉是同一种故障）；
 *   - mqtt@4 虽是 ES5，但实测其 websocket-stream 层连 broker.emqx.io 时收不到 CONNACK，
 *     20 秒必然超时（已用调试日志与 WebSocket 拦截确认）。
 * 本游戏只需要「订阅话题 / 发消息 / 收消息」，QoS 0 足够，因此自己实现最小子集：
 * 体积从几百 KB 降到几 KB，且保证在任何支持 WebSocket 的浏览器（含微信内置）都能跑。
 *
 * 支持：CONNECT(含 Last Will) / CONNACK / SUBSCRIBE / SUBACK / PUBLISH / PINGREQ / PINGRESP / DISCONNECT
 * 不支持：QoS 1/2、持久会话、TLS 客户端证书（本场景均不需要）
 *
 * API（刻意与 mqtt.js 保持相似的用法）：
 *   var c = mqttLite.connect('wss://host:port/path', {
 *       clientId: 'xxx', keepalive: 30, connectTimeout: 20000, clean: true,
 *       will: { topic: 't', payload: 's', qos: 0, retain: false }
 *   });
 *   c.on('connect'|'message'|'error'|'close', fn)
 *   c.subscribe(topic, { qos: 0 }, cb)
 *   c.publish(topic, payloadString, { qos: 0 }, cb)
 *   c.end(force)
 *   c.connected  // boolean
 */
(function (global) {
    'use strict';

    var TYPE_CONNECT = 0x10;
    var TYPE_CONNACK = 0x20;
    var TYPE_PUBLISH = 0x30;
    var TYPE_SUBSCRIBE = 0x82;
    var TYPE_SUBACK = 0x90;
    var TYPE_PINGREQ = 0xc0;
    var TYPE_PINGRESP = 0xd0;
    var TYPE_DISCONNECT = 0xe0;

    /* ---------- UTF-8 编解码（带 ES5 回退，避免依赖 TextEncoder） ---------- */

    function utf8Encode(str) {
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(str);
        }
        var bytes = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) {
                bytes.push(c);
            } else if (c < 0x800) {
                bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
            } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
                var c2 = str.charCodeAt(i + 1);
                var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
                i++;
                bytes.push(
                    0xf0 | (cp >> 18),
                    0x80 | ((cp >> 12) & 0x3f),
                    0x80 | ((cp >> 6) & 0x3f),
                    0x80 | (cp & 0x3f)
                );
            } else {
                bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            }
        }
        return new Uint8Array(bytes);
    }

    function utf8Decode(bytes) {
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8').decode(bytes);
        }
        var out = '';
        var i = 0;
        while (i < bytes.length) {
            var b = bytes[i++];
            if (b < 0x80) {
                out += String.fromCharCode(b);
            } else if (b < 0xe0) {
                out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
            } else if (b < 0xf0) {
                out += String.fromCharCode(
                    ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
                );
            } else {
                var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
                         ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
                cp -= 0x10000;
                out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
            }
        }
        return out;
    }

    /* ---------- 剩余长度（变长整数）编解码 ---------- */

    function encodeLength(len) {
        var out = [];
        do {
            var digit = len % 128;
            len = Math.floor(len / 128);
            if (len > 0) digit = digit | 0x80;
            out.push(digit);
        } while (len > 0);
        return out;
    }

    function encodeString(str) {
        var body = utf8Encode(str);
        var buf = new Uint8Array(2 + body.length);
        buf[0] = (body.length >> 8) & 0xff;
        buf[1] = body.length & 0xff;
        buf.set(body, 2);
        return buf;
    }

    function concat(chunks) {
        var total = 0;
        for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
        var out = new Uint8Array(total);
        var off = 0;
        for (var j = 0; j < chunks.length; j++) {
            out.set(chunks[j], off);
            off += chunks[j].length;
        }
        return out;
    }

    /** 组装一个完整报文：固定头(type) + 变长长度 + 载荷 */
    function buildPacket(type, payloadChunks) {
        var payload = concat(payloadChunks);
        var header = [type].concat(encodeLength(payload.length));
        var head = new Uint8Array(header.length);
        for (var i = 0; i < header.length; i++) head[i] = header[i];
        return concat([head, payload]);
    }

    /* ---------- 客户端 ---------- */

    function Client(url, opts) {
        opts = opts || {};
        this.url = url;
        this.opts = opts;
        this.clientId = opts.clientId || ('ml_' + Math.random().toString(16).slice(2, 12));
        this.keepalive = opts.keepalive || 30;
        this.connectTimeout = opts.connectTimeout || 20000;

        this.connected = false;
        this._handlers = {};
        this._ws = null;
        this._buf = new Uint8Array(0);
        this._pid = 1;
        this._subCallbacks = {};
        this._pingTimer = null;
        this._connectTimer = null;
        this._closedByUser = false;
        this._connectSentAt = 0;

        this._open();
    }

    Client.prototype.on = function (evt, fn) {
        if (!this._handlers[evt]) this._handlers[evt] = [];
        this._handlers[evt].push(fn);
        return this;
    };

    Client.prototype._emit = function (evt, a, b) {
        var list = this._handlers[evt];
        if (!list) return;
        for (var i = 0; i < list.length; i++) {
            try { list[i](a, b); } catch (e) { /* 单个回调出错不影响其它 */ }
        }
    };

    Client.prototype._open = function () {
        var self = this;
        var ws;
        try {
            // MQTT over WebSocket 要求子协议为 'mqtt'
            ws = new WebSocket(this.url, 'mqtt');
        } catch (e) {
            this._emit('error', new Error('无法创建 WebSocket: ' + e.message));
            return;
        }
        ws.binaryType = 'arraybuffer';
        this._ws = ws;

        this._connectTimer = setTimeout(function () {
            if (!self.connected) {
                self._emit('error', new Error('连接 broker 超时（' + self.connectTimeout + 'ms 内未收到 CONNACK）'));
                try { ws.close(); } catch (e) {}
            }
        }, this.connectTimeout);

        ws.onopen = function () {
            self._connectSentAt = Date.now();
            self._sendConnect();
        };

        ws.onmessage = function (ev) {
            var data = ev.data;
            if (typeof data === 'string') return;   // MQTT 必须是二进制帧
            self._onBytes(new Uint8Array(data));
        };

        ws.onerror = function () {
            // 浏览器的 error 事件不含细节，统一提示
            if (!self.connected) {
                self._emit('error', new Error('WebSocket 连接失败'));
            }
        };

        ws.onclose = function (ev) {
            clearTimeout(self._connectTimer);
            clearInterval(self._pingTimer);
            var wasConnected = self.connected;
            self.connected = false;
            if (self._closedByUser) {
                self._emit('close');
                return;
            }
            self._emit('close');
            if (!wasConnected) {
                self._emit('error', new Error('连接被关闭（code=' + ev.code + '）'));
            }
        };
    };

    Client.prototype._sendConnect = function () {
        var chunks = [];
        chunks.push(encodeString('MQTT'));            // 协议名
        chunks.push(new Uint8Array([4]));             // 协议级别 4 = 3.1.1

        var flags = 0;
        var payload = [];
        var will = this.opts.will;

        if (will && will.topic) {
            flags |= 0x04;                            // will flag
            flags |= ((will.qos || 0) & 0x03) << 3;   // will qos
            if (will.retain) flags |= 0x20;           // will retain
        }
        if (this.opts.clean !== false) flags |= 0x02; // clean session

        chunks.push(new Uint8Array([flags]));
        chunks.push(new Uint8Array([(this.keepalive >> 8) & 0xff, this.keepalive & 0xff]));

        payload.push(encodeString(this.clientId));
        if (will && will.topic) {
            payload.push(encodeString(will.topic));
            payload.push(encodeString(String(will.payload == null ? '' : will.payload)));
        }

        this._rawSend(buildPacket(TYPE_CONNECT, chunks.concat(payload)));
    };

    Client.prototype._rawSend = function (bytes) {
        if (!this._ws || this._ws.readyState !== 1) return false;
        try {
            this._ws.send(bytes);
            return true;
        } catch (e) {
            return false;
        }
    };

    /* ---------- 收包 ---------- */

    Client.prototype._onBytes = function (chunk) {
        // 累积，处理粘包 / 拆包
        this._buf = concat([this._buf, chunk]);

        while (this._buf.length >= 2) {
            var b0 = this._buf[0];
            // 解析剩余长度（最多 4 字节）
            var mul = 1, len = 0, i = 1, ok = false;
            while (i < this._buf.length && i <= 4) {
                var d = this._buf[i];
                len += (d & 0x7f) * mul;
                mul *= 128;
                i++;
                if ((d & 0x80) === 0) { ok = true; break; }
            }
            if (!ok) return;                          // 长度字段还没收全
            if (this._buf.length < i + len) return;   // 载荷还没收全

            var packet = this._buf.subarray(i, i + len);
            this._buf = this._buf.subarray(i + len);
            this._handlePacket(b0, packet);
        }
    };

    Client.prototype._handlePacket = function (b0, body) {
        var type = b0 & 0xf0;

        if (type === TYPE_CONNACK) {
            clearTimeout(this._connectTimer);
            var rc = body.length > 1 ? body[1] : 1;
            if (rc === 0) {
                this.connected = true;
                this._startPing();
                this._emit('connect');
            } else {
                this._emit('error', new Error('broker 拒绝连接，返回码 ' + rc));
                try { this._ws.close(); } catch (e) {}
            }
            return;
        }

        if (type === TYPE_SUBACK) {
            var pid = (body[0] << 8) | body[1];
            var cb = this._subCallbacks[pid];
            if (cb) {
                delete this._subCallbacks[pid];
                cb(body.length > 2 && body[2] === 0x80 ? new Error('订阅被拒绝') : null);
            }
            return;
        }

        if (type === TYPE_PUBLISH) {
            var qos = (b0 & 0x06) >> 1;
            var tlen = (body[0] << 8) | body[1];
            var topic = utf8Decode(body.subarray(2, 2 + tlen));
            var off = 2 + tlen;
            if (qos > 0) off += 2;                    // 跳过 packet id（我们只用 QoS 0 收，防御性处理）
            var payloadText = utf8Decode(body.subarray(off));
            this._emit('message', topic, payloadText);
            return;
        }

        if (type === TYPE_PINGRESP) return;
    };

    Client.prototype._startPing = function () {
        var self = this;
        clearInterval(this._pingTimer);
        var interval = Math.max(5, Math.floor(this.keepalive / 2)) * 1000;
        this._pingTimer = setInterval(function () {
            if (self.connected) {
                self._rawSend(buildPacket(TYPE_PINGREQ, []));
            }
        }, interval);
    };

    /* ---------- 公开 API ---------- */

    Client.prototype.subscribe = function (topic, o, cb) {
        if (typeof o === 'function') { cb = o; o = {}; }
        var qos = (o && o.qos) || 0;
        var pid = this._pid++;
        if (pid > 65535) this._pid = 1;
        if (cb) this._subCallbacks[pid] = cb;
        this._rawSend(buildPacket(TYPE_SUBSCRIBE, [
            new Uint8Array([(pid >> 8) & 0xff, pid & 0xff]),
            encodeString(topic),
            new Uint8Array([qos]),
        ]));
        return this;
    };

    Client.prototype.publish = function (topic, payload, o, cb) {
        if (typeof o === 'function') { cb = o; o = {}; }
        var text = (typeof payload === 'string') ? payload : String(payload);
        var ok = this._rawSend(buildPacket(TYPE_PUBLISH, [
            encodeString(topic),
            utf8Encode(text),
        ]));
        if (cb) setTimeout(function () { cb(ok ? null : new Error('未连接')); }, 0);
        return this;
    };

    Client.prototype.end = function () {
        this._closedByUser = true;
        clearTimeout(this._connectTimer);
        clearInterval(this._pingTimer);
        try { this._rawSend(buildPacket(TYPE_DISCONNECT, [])); } catch (e) {}
        try { this._ws.close(); } catch (e) {}
        this.connected = false;
        return this;
    };

    global.mqttLite = {
        connect: function (url, opts) { return new Client(url, opts); },
        version: '1.0.0-lite',
    };
}(typeof window !== 'undefined' ? window : this));
