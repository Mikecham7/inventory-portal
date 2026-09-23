const serverless = require('serverless-http');
// Netlify runs this exact Express app (not a separate copy), so every route —
// login, chat, admin client management, account activation/recovery, inventory —
// stays in sync between local dev (node api/server.js) and production automatically.
const { app } = require('../../api/server.js');

module.exports.handler = serverless(app);

