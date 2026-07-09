require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Пароль для панели модератора.
// Меняется в файле .env (переменная MOD_PASSWORD), см. README.
const PASSWORD = process.env.MOD_PASSWORD || 'meowh0cki2026';

app.use(express.static(path.join(__dirname, 'public')));

// Текущее состояние медиа-объектов на оверлее (чтобы новый модератор видел актуальную картину)
let mediaItems = {};

io.on('connection', (socket) => {
  let authed = false;

  // Панель модератора присылает пароль
  socket.on('auth', (pass) => {
    if (pass === PASSWORD) {
      authed = true;
      socket.emit('auth-result', true);
      socket.emit('state', { media: mediaItems });
    } else {
      socket.emit('auth-result', false);
    }
  });

  // Оверлей (браузер-сурс в OBS) просто просит текущее состояние
  socket.on('overlay-join', () => {
    socket.emit('state', { media: mediaItems });
  });

  socket.on('draw', (data) => {
    if (!authed) return;
    socket.broadcast.emit('draw', data);
  });

  socket.on('clear-canvas', () => {
    if (!authed) return;
    io.emit('clear-canvas');
  });

  socket.on('add-media', (item) => {
    if (!authed) return;
    mediaItems[item.id] = item;
    io.emit('add-media', item);
  });

  socket.on('remove-media', (id) => {
    if (!authed) return;
    delete mediaItems[id];
    io.emit('remove-media', id);
  });

  socket.on('clear-media', () => {
    if (!authed) return;
    mediaItems = {};
    io.emit('clear-media');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});