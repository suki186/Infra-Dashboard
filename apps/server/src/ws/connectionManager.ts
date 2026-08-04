import type { WebSocket } from 'ws';

export function createConnectionManager() {
  const clients = new Set<WebSocket>();

  function addClient(socket: WebSocket): void {
    clients.add(socket);
    socket.once('close', () => {
      clients.delete(socket);
    });
  }

  function removeClient(socket: WebSocket): void {
    clients.delete(socket);
  }

  function getClients(): ReadonlySet<WebSocket> {
    return clients;
  }

  return { addClient, removeClient, getClients };
}

export type ConnectionManager = ReturnType<typeof createConnectionManager>;

export function createConnectionHandler(connectionManager: ConnectionManager) {
  return function handleConnection(socket: WebSocket): void {
    connectionManager.addClient(socket);
  };
}
