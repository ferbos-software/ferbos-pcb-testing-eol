#!/usr/bin/env python3
"""Static file server for the Ferbos PCB EOL tester UI.

Plain `python3 -m http.server` sends only Last-Modified, with no Cache-Control and
no ETag. Chrome then applies heuristic caching and will happily serve an ES module
import (js/core/*.js) from cache without revalidating, even though the entry module
was re-fetched. The result is a page running a mix of old and new modules, which
shows up as confusing "x is not a function" errors after an edit.

This server sends no-store on every response so a plain reload always gets the
current files.

Usage (from the repository root):

    python3 serve.py                 # http://127.0.0.1:8080/ferbos-pcb-testing/
    python3 serve.py --port 9000
    python3 serve.py --bind 0.0.0.0  # reachable from other machines on the network
"""

import argparse
import http.server
import socketserver


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_response(self, code, message=None):
        # Skip the per-request 304 path entirely: with no-store there is nothing to revalidate.
        super().send_response(code, message)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8080, help="port to listen on (default: 8080)")
    parser.add_argument("--bind", default="127.0.0.1", help="address to bind (default: 127.0.0.1, localhost only)")
    args = parser.parse_args()

    with Server((args.bind, args.port), NoCacheHandler) as httpd:
        print(f"Serving with caching disabled on http://{args.bind}:{args.port}/ferbos-pcb-testing/")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
