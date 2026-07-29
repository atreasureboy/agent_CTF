#!/usr/bin/env python3
import http.server
import socketserver
import os

FLAG = "flag{d1r_tr4v3rs4l_m4st3r}"

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<h1>Welcome!</h1><p>Find the flag in /secret/flag.txt</p>')
        elif self.path == '/secret/flag.txt':
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(FLAG.encode())
        elif self.path.startswith('/../') or '..' in self.path:
            # Vulnerable to directory traversal
            filepath = self.path.lstrip('/')
            if os.path.exists(filepath):
                self.send_response(200)
                self.send_header('Content-type', 'text/plain')
                self.end_headers()
                with open(filepath, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self.send_response(404)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

PORT = 8765
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"Serving on port {PORT}")
    httpd.serve_forever()
