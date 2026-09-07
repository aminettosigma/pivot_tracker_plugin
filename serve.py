"""Dev server for the plugin. Identical to `python3 -m http.server` except every
response is marked no-store -- Sigma loads the plugin in an iframe that will
otherwise serve a cached app.js, so panel changes appear to be missing until a
hard refresh."""
import functools
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    # Conditional requests would still yield a cached body, so never answer 304.
    def send_head(self):
        self.headers.replace_header('If-Modified-Since', '') \
            if 'If-Modified-Since' in self.headers else None
        if 'If-None-Match' in self.headers:
            del self.headers['If-None-Match']
        return super().send_head()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    handler = functools.partial(NoCacheHandler, directory='.')
    print(f'serving {port} with caching disabled')
    http.server.ThreadingHTTPServer(('', port), handler).serve_forever()
