require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Увеличиваем лимит размера сообщения — нужно, чтобы можно было
// пересылать картинки/гифки с компьютера (в виде base64) через сокет.
const io = new Server(server, {
  maxHttpBufferSize: 15 * 1024 * 1024 // 15 МБ
});

// Пароль для панели модератора. Задаётся в Render -> Environment Variables.
const PASSWORD = process.env.MOD_PASSWORD || 'meowh0cki2026';

app.use(express.static(path.join(__dirname, 'public')));

// Текущее состояние медиа-объектов на оверлее
let mediaItems = {};

io.on('connection', (socket) => {
  let authed = false;

  socket.on('auth', (pass) => {
    if (pass === PASSWORD) {
      authed = true;
      socket.emit('auth-result', true);
      socket.emit('state', { media: mediaItems });
    } else {
      socket.emit('auth-result', false);
    }
  });

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

  // Добавление нового медиа-объекта (полные данные, включая картинку/ссылку)
  socket.on('add-media', (item) => {
    if (!authed) return;
    mediaItems[item.id] = item;
    socket.broadcast.emit('add-media', item);
  });

  // Перемещение/изменение размера существующего объекта (лёгкий payload,
  // без пересылки самой картинки — только координаты)
  socket.on('update-media', (data) => {
    if (!authed) return;
    const item = mediaItems[data.id];
    if (!item) return;
    item.x = data.x;
    item.y = data.y;
    item.w = data.w;
    item.h = data.h;
    socket.broadcast.emit('update-media', data);
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
