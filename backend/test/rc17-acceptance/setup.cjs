'use strict';
const g = require('./guard.cjs');
const packet = g.readPacket(3);
g.insist(packet.action === 'test');
global.__rcPacket = packet;
const net = require('node:net'),
  tls = require('node:tls');
const original = net.Socket.prototype.connect,
  ports = new Set([58432]);
global.__rcHttpPort = (port) => {
  g.insist(
    Number.isInteger(port) &&
      port >= 1024 &&
      ![5432, 55432, 56432, 57432, 58432].includes(port),
  );
  ports.add(port);
};
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = typeof first === 'object' ? first.host : args[1],
    port = Number(typeof first === 'object' ? first.port : first);
  g.insist(host === '127.0.0.1' && ports.has(port), 'RCR_NETWORK_REFUSED');
  return original.apply(this, args);
};
tls.connect = () => {
  throw new Error('RCR_TLS_EXTERNAL_REFUSED');
};
const Module = require('node:module'),
  load = Module._load;
Module._load = function (name, parent, main) {
  if (
    /dotenv|app\.module|prisma\.config|@openrouter\/sdk|nodemailer|google-auth-library|@apple\/app-store-server-library/.test(
      name,
    )
  )
    throw new Error('RCR_EXTERNAL_OR_APP_IMPORT_REFUSED');
  return load.call(this, name, parent, main);
};
