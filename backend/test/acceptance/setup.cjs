'use strict';
const { readPacket } = require('./guard.cjs');
const packet = readPacket(3);
if (packet.action !== 'test')
  throw new Error('ACCEPTANCE_TEST_APPROVAL_REQUIRED');
// Only this explicit pipe supplies credentials. No global app URL is populated.
global.__acceptancePacket = packet;
const net = require('node:net');
const connect = net.Socket.prototype.connect;
const allowedPorts = new Set([56432]);
global.__allowAcceptanceHttpPort = (port) => {
  if (!Number.isInteger(port) || port < 1024 || port === 5432 || port === 55432)
    throw new Error('HTTP_PORT_REFUSED');
  allowedPorts.add(port);
};
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const port = Number(typeof first === 'object' ? first.port : first);
  const host = typeof first === 'object' ? first.host : args[1];
  if (host !== '127.0.0.1' || !allowedPorts.has(port))
    throw new Error('UNAPPROVED_NETWORK_REFUSED');
  return connect.apply(this, args);
};
// Fail before a dependency can load dotenv or instantiate the production module.
const Module = require('node:module');
const load = Module._load;
Module._load = function (request, parent, main) {
  if (/dotenv|app\.module|prisma\.config/.test(request))
    throw new Error('APPLICATION_BOOTSTRAP_REFUSED');
  return load.call(this, request, parent, main);
};
