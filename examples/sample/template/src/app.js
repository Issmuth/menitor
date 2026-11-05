import http from 'node:http';

/**
 * Answer one request. Task 1 adds the home page here.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
export function handle(req, res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

export function createServer() {
  return http.createServer(handle);
}
