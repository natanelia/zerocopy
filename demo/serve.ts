const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    
    // Bundle TypeScript files on-the-fly for browser
    if (path.endsWith('.ts')) {
      const filePath = path.startsWith('/demo/') ? `.${path}` : `.${path}`;
      const result = await Bun.build({
        entrypoints: [filePath],
        target: 'browser',
        format: 'esm',
      });
      if (!result.success) {
        console.error(result.logs);
        return new Response('Build error', { status: 500 });
      }
      const code = await result.outputs[0].text();
      return new Response(code, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp'
        }
      });
    }
    
    // Serve static files
    let file = Bun.file(`./demo${path}`);
    if (!(await file.exists())) file = Bun.file(`.${path}`);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    
    const ext = path.split('.').pop();
    const types: Record<string, string> = {
      html: 'text/html', js: 'application/javascript', wasm: 'application/wasm', json: 'application/json'
    };
    
    return new Response(file, {
      headers: {
        'Content-Type': types[ext!] || 'text/plain',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    });
  }
});

console.log(`Demo server running at http://localhost:${server.port}`);
