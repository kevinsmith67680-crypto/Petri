// ---------------------------------------------------------------------------
// Deployment config.
//
// Set SERVER_URL when the client is hosted somewhere that cannot run the game
// server — GitHub Pages, Netlify, any static CDN. Leave it empty and the
// client connects back to whatever host served the page, which is what you
// want when running `npm start` or deploying the whole thing to one box.
//
// Must be wss:// (not ws://) if the page itself is served over https, or the
// browser will block the connection as mixed content.
// ---------------------------------------------------------------------------

export const SERVER_URL = "";   // e.g. "wss://petri-server.onrender.com"
