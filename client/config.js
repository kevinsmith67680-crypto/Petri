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

// Empty is correct for engulfs.io: one host serves the page and the game
// server, so the client connects back to whatever served it. Only set this if
// the client is ever split onto static hosting — e.g. "wss://engulfs.io".
export const SERVER_URL = "";
