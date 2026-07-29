#!/usr/bin/env python3
import http.server
import sqlite3
import os
import json
from urllib.parse import unquote_plus

DB_PATH = "app.db"
FLAG = "flag{sql1_1nj3ct10n_m4st3r}"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER, username TEXT, password TEXT, role TEXT)")
    c.execute("INSERT OR IGNORE INTO users VALUES (1, 'admin', 'secret123', 'admin')")
    c.execute("INSERT OR IGNORE INTO users VALUES (2, 'guest', 'guest', 'user')")
    conn.commit()
    conn.close()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b"""<h1>Login</h1>
<form method="POST" action="/login">
Username: <input name="username"><br>
Password: <input name="password"><br>
<input type="submit">
</form>""")
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        if self.path == '/login':
            length = int(self.headers.get('Content-Length', 0))
            data = self.rfile.read(length).decode()
            params = dict(x.split('=') for x in data.split('&') if '=' in x)
            username = unquote_plus(params.get('username', ''))
            password = unquote_plus(params.get('password', ''))
            
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            # Vulnerable query!
            query = f"SELECT * FROM users WHERE username='{username}' AND password='{password}'"
            try:
                c.execute(query)
                result = c.fetchone()
                if result:
                    if result[3] == 'admin':
                        self.send_response(200)
                        self.send_header('Content-type', 'text/plain')
                        self.end_headers()
                        self.wfile.write(f"Welcome admin! Flag: {FLAG}".encode())
                    else:
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(b"Welcome user!")
                else:
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b"Login failed")
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
            conn.close()

if __name__ == '__main__':
    init_db()
    server = http.server.HTTPServer(('127.0.0.1', 8766), Handler)
    print("Server running on http://127.0.0.1:8766")
    server.serve_forever()
