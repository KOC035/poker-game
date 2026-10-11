/**
 * server.js — 自建 PeerJS 信令服务器
 *
 * 为什么需要它：
 *   PeerJS 官方公共信令服务器 0.peerjs.com 在部分网络下 TCP 可连、但 TLS/WSS 握手会被
 *   中途重置（SNI 阻断），表现为「建房后一直没反应」。
 *   本项目默认指向一台第三方公共实例 peerjs-server.onrender.com（实测可用），
 *   但它不受我们控制、免费层会休眠。想让联机长期稳定，请把本服务部署到自己的账号下，
 *   再把地址填回 index.html 的 SIGNALING_SERVERS 数组最前面。
 *
 * 本地运行：
 *   cd server && npm install && npm start
 *   → 信令服务器监听 http://localhost:9000
 *
 * 部署到 Render / Railway 等平台：见同目录 render.yaml 与仓库 README。
 */

const { PeerServer } = require('peer');

const PORT = Number(process.env.PORT) || 9000;
const PATH = process.env.PEER_PATH || '/';

// proxied=true：部署在 Render / Railway / Nginx 等反向代理之后必须开启，
// 否则服务端拿到的地址会是内网地址，客户端连不上。
const PROXIED = process.env.PEER_PROXIED !== 'false';

const peerServer = PeerServer({
    port: PORT,
    path: PATH,
    proxied: PROXIED,
    allow_discovery: false,   // 不对外公开房间/客户端列表
    alive_timeout: 60000,     // 60 秒无心跳视为掉线
});

peerServer.on('connection', (client) => {
    console.log(`[peer] 连接   ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
    console.log(`[peer] 断开   ${client.getId()}`);
});

console.log('==============================================');
console.log(' PeerJS 信令服务器已启动');
console.log(`   监听端口 : ${PORT}`);
console.log(`   路径     : ${PATH}`);
console.log(`   proxied  : ${PROXIED}`);
console.log(`   自检地址 : http://localhost:${PORT}${PATH === '/' ? '' : PATH}/peerjs/id`);
console.log('==============================================');

// 未捕获异常不要直接退出，否则公共平台上一次抖动就会把服务打挂
process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection:', reason);
});
