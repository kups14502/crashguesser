#!/usr/bin/env python3
import http.server
import socketserver

PORT = 8095

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

if __name__ == "__main__":
    with ReusableTCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
        httpd.serve_forever()
