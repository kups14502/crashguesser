#!/usr/bin/env python3
import http.server
import socketserver
import urllib.parse

PORT = 8095

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    # The site is the files beside this script, but so are .git, .test and the
    # script itself: refuse dot paths, Python files and directory listings.
    def send_head(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if any(p.startswith(".") for p in path.split("/") if p) or path.lower().endswith(".py"):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

if __name__ == "__main__":
    with ReusableTCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
        httpd.serve_forever()
