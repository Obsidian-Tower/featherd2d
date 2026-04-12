
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    
    if (url.pathname === "/") {
      return serveStatic("index.html", env);
    }
  }
};


// ================================
// 🔥 HANDLERS
// ================================
