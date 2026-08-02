require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 25 * 1024 * 1024
});

const PASSWORD = process.env.MOD_PASSWORD || 'meowh0cki2026';

app.use(express.static(path.join(__dirname, 'public')));

// --- Прокси для "браузер-источников", которые запрещают показывать себя
// во фрейме (X-Frame-Options / Content-Security-Policy), например ChatIS.
// Панель модератора подставляет сюда ссылку так: /proxy?url=<ссылка>
// Ответ отдаём с нашего же домена и без запрещающих заголовков — поэтому
// браузер больше не против встроить это внутрь overlay.html.
app.get('/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url param');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return res.status(400).send('Bad url');
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return res.status(400).send('Bad protocol');
  }

  const lib = targetUrl.protocol === 'http:' ? http : https;

  const upstreamReq = lib.get(targetUrl, {
    headers: { 'User-Agent': req.get('User-Agent') || 'Mozilla/5.0' }
  }, (upstreamRes) => {
    // Редиректы просто прогоняем через тот же прокси-роут
    if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
      const redirected = new URL(upstreamRes.headers.location, targetUrl).toString();
      upstreamRes.resume(); // сливаем тело, чтобы не висело соединение
      return res.redirect('/proxy?url=' + encodeURIComponent(redirected));
    }

    const contentType = upstreamRes.headers['content-type'] || '';
    res.status(upstreamRes.statusCode);
    if (contentType) res.set('Content-Type', contentType);
    // Явно не копируем заголовки, которые запрещают встраивание во фрейм
    res.removeHeader('X-Frame-Options');
    res.set('Content-Security-Policy', '');

    if (contentType.includes('text/html')) {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        // Переписываем корневые относительные пути (src="/..." href="/...")
        // на абсолютные — иначе CSS/JS/картинки сайта попытаются
        // загрузиться с нашего домена и не найдутся
        body = body.replace(/(src|href)=("|')\/(?!\/)/g, `$1=$2${targetUrl.origin}/`);
        res.send(body);
      });
    } else {
      upstreamRes.pipe(res);
    }
  });

  upstreamReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
  });

  req.on('close', () => upstreamReq.destroy());
});

// Защита от полного падения сервера: если где-то вылетит необработанная
// ошибка, просто логируем её и продолжаем работать, вместо того чтобы
// ронять весь процесс целиком
process.on('uncaughtException', (err) => {
  console.error('Необработанная ошибка (сервер продолжает работать):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Необработанный rejection (сервер продолжает работать):', err);
});

let mediaItems = {};   // id -> {id, type, url, x, y, w, h, z, zoom, offsetX, offsetY, cropW, cropH, videoId?}
let history = [];      // [{ id, kind: 'stroke'|'shape'|'text', ... }]
let folders = {};      // id -> { id, name, memberIds: [] }
let nextZ = 1;
let nicknamesByIp = {}; // ip -> nickname, сохраняется на диск вместе с остальным state

// Кто сейчас реально онлайн (только в памяти, не сохраняется на диск —
// список должен отражать актуальные соединения, а не переживать рестарт)
const onlineUsers = {}; // socket.id -> { nickname, ip }

function getClientIp(socket) {
  // Render стоит за прокси — реальный IP клиента приходит в заголовке,
  // socket.handshake.address без этого будет адресом самого Render
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address;
}

function broadcastOnlineList() {
  // Уникальные ники (если один и тот же человек открыл несколько вкладок —
  // в списке он всё равно один)
  const names = [...new Set(Object.values(onlineUsers).map(u => u.nickname))];
  io.emit('online-list', names);
}

// --- Сохранение состояния на диск (переживает "засыпание" сервера, но
// стирается при полном редеплое — так было и раньше, это особенность
// Render, а не что-то новое) ---
const STATE_FILE = path.join(__dirname, 'data', 'state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    mediaItems = data.mediaItems || {};
    history = data.history || [];
    folders = data.folders || {};
    nextZ = data.nextZ || 1;
    nicknamesByIp = data.nicknamesByIp || {};
    console.log('Состояние восстановлено из файла (' + Object.keys(mediaItems).length + ' медиа-объектов)');
  } catch (e) {
    console.log('Сохранённого состояния не найдено — начинаем с чистого листа');
  }
}

let saveTimeout = null;
function saveStateDebounced() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ mediaItems, history, folders, nextZ, nicknamesByIp }));
    } catch (e) {
      console.error('Не удалось сохранить состояние:', e.message);
    }
  }, 800);
}

loadState();

// --- Универсальная отмена (Ctrl+Z) ---
// Перед КАЖДЫМ значимым действием клиент присылает 'checkpoint' — мы
// сохраняем снимок состояния "до" этого действия. Ctrl+Z достаёт последний
// снимок и полностью восстанавливает по нему сцену у всех.
//
// ВАЖНО: раньше тут использовался JSON.stringify всего состояния, что при
// каждом чекпоинте ПОЛНОСТЬЮ дублировало base64-содержимое картинок/гифок/
// видео в памяти. При нескольких загруженных медиа и десятках чекпоинтов
// (а они шлются часто — при каждом перетаскивании, клике и т.д.) память
// сервера быстро забивалась под завязку и Render его перезапускал — из-за
// этого всё "пропадало". Теперь копируем только сами объекты-обёртки
// (x, y, поворот и т.д.), а сама строка с base64-файлом (item.url) не
// копируется — переиспользуется по ссылке, т.к. она не меняется между
// чекпоинтами и в JS строки всё равно неизменяемы (immutable).
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 25;

function cloneMediaItems(items) {
  const clone = {};
  for (const id in items) {
    clone[id] = Object.assign({}, items[id]); // неглубокая копия — url не дублируется
  }
  return clone;
}

function snapshotState() {
  return {
    mediaItems: cloneMediaItems(mediaItems),
    history: history.map(h => (h.kind === 'stroke' ? { id: h.id, kind: 'stroke', segments: h.segments.slice() } : Object.assign({}, h))),
    folders: JSON.parse(JSON.stringify(folders)), // папки маленькие, тут ок
    nextZ
  };
}

function pushCheckpoint() {
  undoStack.push(snapshotState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  // Новое действие "обнуляет" возможность повторить то, что было отменено раньше
  redoStack = [];
}

function getOrCreateStroke(strokeId) {
  let entry = history.find(h => h.id === strokeId && h.kind === 'stroke');
  if (!entry) {
    entry = { id: strokeId, kind: 'stroke', segments: [] };
    history.push(entry);
  }
  return entry;
}

function removeItemFromAllFolders(itemId) {
  Object.values(folders).forEach((f) => {
    const idx = f.memberIds.indexOf(itemId);
    if (idx > -1) f.memberIds.splice(idx, 1);
  });
}

io.on('connection', (socket) => {
  let authed = false;
  const clientIp = getClientIp(socket);

  socket.on('auth', (pass) => {
    if (pass !== PASSWORD) {
      socket.emit('auth-result', { ok: false });
      return;
    }
    authed = true;
    socket.emit('state', { media: mediaItems, history, folders });

    const savedNickname = nicknamesByIp[clientIp];
    if (savedNickname) {
      // Ник уже закреплён за этим IP раньше — вводить заново не нужно
      onlineUsers[socket.id] = { nickname: savedNickname, ip: clientIp };
      socket.emit('auth-result', { ok: true, nickname: savedNickname });
      broadcastOnlineList();
    } else {
      // Пароль верный, но ника ещё нет — клиент должен спросить и прислать 'set-nickname'
      socket.emit('auth-result', { ok: true, nickname: null });
    }
  });

  socket.on('set-nickname', (name) => {
    if (!authed) return;
    const nickname = String(name || '').trim().slice(0, 24);
    if (!nickname) return;
    nicknamesByIp[clientIp] = nickname;
    onlineUsers[socket.id] = { nickname, ip: clientIp };
    socket.emit('nickname-set', nickname);
    broadcastOnlineList();
    saveStateDebounced();
  });

  socket.on('disconnect', () => {
    if (onlineUsers[socket.id]) {
      delete onlineUsers[socket.id];
      broadcastOnlineList();
    }
  });

  socket.on('overlay-join', () => {
    socket.emit('state', { media: mediaItems, history, folders });
  });

  // Клиент шлёт это ПЕРЕД началом любого значимого действия (начало
  // перетаскивания, добавление объекта, удаление и т.д.)
  socket.on('checkpoint', () => {
    if (!authed) return;
    pushCheckpoint();
  });

  socket.on('undo', () => {
    if (!authed) return;
    if (undoStack.length === 0) return;
    redoStack.push(snapshotState());
    if (redoStack.length > MAX_UNDO) redoStack.shift();
    const snapshot = undoStack.pop();
    mediaItems = snapshot.mediaItems;
    history = snapshot.history;
    folders = snapshot.folders;
    nextZ = snapshot.nextZ;
    io.emit('state', { media: mediaItems, history, folders });
    saveStateDebounced();
  });

  socket.on('redo', () => {
    if (!authed) return;
    if (redoStack.length === 0) return;
    undoStack.push(snapshotState());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    const snapshot = redoStack.pop();
    mediaItems = snapshot.mediaItems;
    history = snapshot.history;
    folders = snapshot.folders;
    nextZ = snapshot.nextZ;
    io.emit('state', { media: mediaItems, history, folders });
    saveStateDebounced();
  });

  socket.on('draw', (data) => {
    if (!authed) return;
    socket.broadcast.emit('draw', data);
    if (data.strokeId) {
      getOrCreateStroke(data.strokeId).segments.push(data);
    }
    saveStateDebounced();
  });

  socket.on('add-object', (obj) => {
    if (!authed) return;
    history.push(obj);
    socket.broadcast.emit('add-object', obj);
    saveStateDebounced();
  });

  socket.on('clear-canvas', () => {
    if (!authed) return;
    history = [];
    io.emit('clear-canvas');
    saveStateDebounced();
  });

  // Добавление медиа — сразу назначаем слой (z), отправитель получает
  // только маленькое подтверждение с z (без пересылки картинки обратно)
  socket.on('add-media', (item) => {
    if (!authed) return;
    item.z = nextZ++;
    mediaItems[item.id] = item;
    socket.broadcast.emit('add-media', item);
    socket.emit('set-z', { id: item.id, z: item.z });
    saveStateDebounced();
  });

  socket.on('update-media', (data) => {
    if (!authed) return;
    const item = mediaItems[data.id];
    if (!item) return;
    item.x = data.x;
    item.y = data.y;
    item.w = data.w;
    item.h = data.h;
    if (data.zoom !== undefined) item.zoom = data.zoom;
    if (data.offsetX !== undefined) item.offsetX = data.offsetX;
    if (data.offsetY !== undefined) item.offsetY = data.offsetY;
    if (data.cropW !== undefined) item.cropW = data.cropW;
    if (data.cropH !== undefined) item.cropH = data.cropH;
    if (data.fontSize !== undefined) item.fontSize = data.fontSize;
    if (data.fontScale !== undefined) item.fontScale = data.fontScale;
    if (data.color !== undefined) item.color = data.color;
    if (data.hidden !== undefined) item.hidden = data.hidden;
    if (data.loop !== undefined) item.loop = data.loop;
    if (data.volume !== undefined) item.volume = data.volume;
    if (data.opacity !== undefined) item.opacity = data.opacity;
    if (data.rotation !== undefined) item.rotation = data.rotation;
    socket.broadcast.emit('update-media', data);
    saveStateDebounced();
  });

  socket.on('update-media-batch', (updates) => {
    if (!authed) return;
    updates.forEach((data) => {
      const item = mediaItems[data.id];
      if (item) {
        item.x = data.x;
        item.y = data.y;
        item.w = data.w;
        item.h = data.h;
      }
    });
    socket.broadcast.emit('update-media-batch', updates);
    saveStateDebounced();
  });

  // Изменение порядка слоёв — приходит полный список id "спереди назад"
  socket.on('reorder-media', (idsInOrder) => {
    if (!authed) return;
    idsInOrder.forEach((id, idx) => {
      if (mediaItems[id]) mediaItems[id].z = idsInOrder.length - idx;
    });
    io.emit('reorder-media', idsInOrder);
    saveStateDebounced();
  });

  socket.on('remove-media', (id) => {
    if (!authed) return;
    delete mediaItems[id];
    removeItemFromAllFolders(id);
    io.emit('remove-media', id);
    io.emit('folders-sync', folders);
    saveStateDebounced();
  });

  socket.on('clear-media', () => {
    if (!authed) return;
    mediaItems = {};
    folders = {};
    io.emit('clear-media');
    io.emit('folders-sync', folders);
    saveStateDebounced();
  });

  socket.on('youtube-control', (data) => {
    if (!authed) return;
    socket.broadcast.emit('youtube-control', data);
  });

  // Play/пауза для загруженных видеофайлов (не YouTube)
  socket.on('video-control', (data) => {
    if (!authed) return;
    socket.broadcast.emit('video-control', data);
  });

  // Перезагрузка браузер-источника (кнопка "Обновить" у объекта типа "browser")
  socket.on('browser-control', (data) => {
    if (!authed) return;
    socket.broadcast.emit('browser-control', data);
  });

  // --- Папки ---
  socket.on('create-folder', (name) => {
    if (!authed) return;
    const id = 'folder' + Date.now() + Math.random().toString(36).slice(2);
    folders[id] = { id, name: (name || 'Папка').slice(0, 40), memberIds: [] };
    io.emit('folders-sync', folders);
    saveStateDebounced();
  });

  socket.on('delete-folder', (id) => {
    if (!authed) return;
    delete folders[id];
    io.emit('folders-sync', folders);
    saveStateDebounced();
  });

  socket.on('rename-folder', (data) => {
    if (!authed) return;
    if (folders[data.id]) {
      folders[data.id].name = (data.name || folders[data.id].name).slice(0, 40);
    }
    io.emit('folders-sync', folders);
    saveStateDebounced();
  });

  socket.on('rename-media', (data) => {
    if (!authed) return;
    const item = mediaItems[data.id];
    if (item) {
      item.label = (data.label || '').slice(0, 60);
    }
    io.emit('rename-media', data);
    saveStateDebounced();
  });

  socket.on('assign-folder', (data) => {
    if (!authed) return;
    removeItemFromAllFolders(data.itemId);
    if (data.folderId && folders[data.folderId]) {
      folders[data.folderId].memberIds.push(data.itemId);
    }
    io.emit('folders-sync', folders);
    saveStateDebounced();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
