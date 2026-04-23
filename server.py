#!/usr/bin/env python3
"""
Local dev server for Sectioner.
Serves static files AND proxies /api/messages → api.anthropic.com
so the browser never makes cross-origin requests.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler


class SectionerHandler(SimpleHTTPRequestHandler):

    def do_POST(self):
        if self.path == '/api/messages':
            self._proxy_to_anthropic()
        else:
            self.send_error(404)

    def _proxy_to_anthropic(self):
        length   = int(self.headers.get('Content-Length', 0))
        body     = self.rfile.read(length)
        api_key  = self.headers.get('x-api-key', '')
        version  = self.headers.get('anthropic-version', '2023-06-01')

        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages',
            data=body,
            headers={
                'x-api-key':          api_key,
                'anthropic-version':  version,
                'content-type':       'application/json',
            },
            method='POST',
        )

        try:
            with urllib.request.urlopen(req) as resp:
                resp_body = resp.read()
                self._send_json(resp.status, resp_body)
        except urllib.error.HTTPError as e:
            resp_body = e.read()
            self._send_json(e.code, resp_body)
        except Exception as e:
            self._send_json(502, json.dumps({'error': str(e)}).encode())

    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Suppress noisy static-file logs, keep API calls visible
        if '/api/' in (args[0] if args else ''):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = HTTPServer(('localhost', port), SectionerHandler)
    print(f'Sectioner running at http://localhost:{port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
