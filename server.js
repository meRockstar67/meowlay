require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 15 * 1024 * 1024
});

const PASSWORD = process.env.MOD_PASSWORD || 'meowh0cki2026';

app.use(express.static(path.join(__dirname, 'public')));

let mediaItems = {};   // id -> {id, type, url, x, y, w, h, z, zoom, offsetX, offsetY, videoId?}
let history = [];      // [{ id, kind: 'stroke'|'shape'|'text', ... }]
let folders = {};      // id -> { id, name, memberIds: [] }
let nextZ = 1;

// --- Сохранение состояния на диск, чтобы всё восстанавливалось после
// перезапуска сервера (например, когда бесплатный тариф "засыпает" от
// простоя и потом просыпается заново) ---
const STATE_FILE = path.join(__dirname, 'data', 'state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    mediaItems = data.mediaItems || {};
    history = data.history || [];
    folders = data.folders || {};
    nextZ = data.nextZ || 1;
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
      fs.writeFileSync(STATE_FILE, JSON.stringify({ mediaItems, history, folders, nextZ }));
    } catch (e) {
      console.error('Не удалось сохранить состояние:', e.message);
    }
  }, 800);
}

loadState();

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

  socket.on('auth', (pass) => {
    if (pass === PASSWORD) {
      authed = true;
      socket.emit('auth-result', true);
      socket.emit('state', { media: mediaItems, history, folders });
    } else {
      socket.emit('auth-result', false);
    }
  });

  socket.on('overlay-join', () => {
    socket.emit('state', { media: mediaItems, history, folders });
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

  socket.on('undo-draw', () => {
    if (!authed) return;
    history.pop();
    io.emit('redraw-canvas', { history });
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
    if (data.fontSize !== undefined) item.fontSize = data.fontSize;
    if (data.fontScale !== undefined) item.fontScale = data.fontScale;
    if (data.color !== undefined) item.color = data.color;
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
