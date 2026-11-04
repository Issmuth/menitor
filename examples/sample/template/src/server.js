import { createServer } from './app.js';

const port = Number(process.env.PORT ?? 3000);
createServer().listen(port, () => {
  console.log(`Recipe box is running on http://localhost:${port}`);
});
