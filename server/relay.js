/**
 * relay.js — 极简 WebSocket 中继服务器
 *
 * 设计原则：服务器【完全不理解业务】。
 *   连接时用 ?room=XXX 加入房间；此后收到的任何消息都原样转发给同房间的其它连接。
 *   谁该收到什么，由客户端在消息里用 __to 字段自己决定。
 *   这样服务端只有几十行，没有状态机、没有协议解析，出错面最小。
 *
 * 为什么需要它：
 *   本项目最初用 WebRTC P2P（跨网络 NAT 打洞失败、微信内置浏览器不支持）；
 *   后来改用公共 MQTT broker（实测境外公共 broker 在国内网络下大面积不可用，
 *   多轮采样只有 0~2/5 的成功率）。自建一台中继是唯一稳定的办法。
 *
 * 本地运行：
 *   cd server && npm install && npm start
 *   → ws://localhost:8080/ws?room=TEST
 *
 * 部署到 Render：见同目录 render.yaml
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const HEARTBEAT_MS = 30000;

/* ---------- HTTP 层：健康检查 + 首页提示 ---------- */
const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
    }
    if (req.url && req.url.startsWith('/stats')) {
        const info = { rooms: rooms.size, clients: wss.clients.size };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(info));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('poker-game relay 正在运行\n\nWebSocket 地址: /ws?room=<房间号>\n');
});

/* ---------- WebSocket 层 ---------- */
const wss = new WebSocketServer({ server, path: '/ws' });

/** 房间号 -> Set<ws> */
const rooms = new Map();

wss.on('connection', (ws, req) => {
    let room = '';
    try {
        const u = new URL(req.url, 'http://localhost');
        room = u.searchParams.get('room') || '';
    } catch (e) { /* 忽略 */ }

    if (!room) {
        try { ws.close(1008, 'missing room'); } catch (e) {}
        return;
    }

    if (!rooms.has(room)) rooms.set(room, new Set());
    const members = rooms.get(room);
    const isFirst = members.size === 0;
    members.add(ws);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    console.log(`[relay] + room=${room} 当前 ${members.size} 人`);

    // 告诉新加入者当前人数；并通知老成员有人来了（便于房主刷新列表）
    broadcast(room, ws, JSON.stringify({ __sys: 'peer-joined', count: members.size }));
    if (!isFirst) {
        try { ws.send(JSON.stringify({ __sys: 'welcome', count: members.size })); } catch (e) {}
    }

    ws.on('message', (data) => {
        // 服务器不理解内容，原样群发给同房间其它连接。
        // ⚠️ 必须转成字符串再发：ws.send(Buffer) 会发【二进制帧】，
        //    浏览器侧收到的就是 Blob，前端 JSON.parse(Blob) 会失败并静默丢弃消息。
        //    传字符串才会走【文本帧】，两端都能直接用。
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        for (const other of members) {
            if (other !== ws && other.readyState === 1) {
                try { other.send(text); } catch (e) { /* 单个失败不影响其它 */ }
            }
        }
    });

    const cleanup = () => {
        members.delete(ws);
        if (members.size === 0) {
            rooms.delete(room);
        } else {
            broadcast(room, ws, JSON.stringify({ __sys: 'peer-left', count: members.size }));
        }
        console.log(`[relay] - room=${room} 剩余 ${members.size} 人`);
    };
    ws.on('close', cleanup);
    ws.on('error', () => { try { ws.terminate(); } catch (e) {} });
});

function broadcast(room, except, text) {
    const members = rooms.get(room);
    if (!members) return;
    for (const other of members) {
        if (other !== except && other.readyState === 1) {
            try { other.send(text); } catch (e) { /* 忽略 */ }
        }
    }
}

/* ---------- 心跳：清理死连接 ---------- */
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            try { ws.terminate(); } catch (e) {}
            return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (e) {}
    });
}, HEARTBEAT_MS);

server.listen(PORT, () => {
    console.log('==============================================');
    console.log(' 扑克中继服务器已启动');
    console.log(`   端口      : ${PORT}`);
    console.log(`   健康检查  : /health`);
    console.log(`   统计      : /stats`);
    console.log(`   房间地址  : /ws?room=<房间号>`);
    console.log('==============================================');
});

process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection:', reason);
});
