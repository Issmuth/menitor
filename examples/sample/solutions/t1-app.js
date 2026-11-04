import http from 'node:http';

const HOME = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Recipe box</title></head>
  <body><h1>Recipe box</h1></body>
</html>`;

/**
 * Answer one request.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
export function handle(req, res) {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HOME);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

export function createServer() {
  return http.createServer(handle);
}
