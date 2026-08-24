#!/usr/bin/env python3
# Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
# SPDX-License-Identifier: Apache-2.0
"""静态服务器, 强制 no-store 缓存头 (开发用, 解决 ES module 缓存问题)。"""
import http.server, socketserver, os, sys

WEB_DIR = os.path.dirname(os.path.abspath(__file__))

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()
    def log_message(self, *args):
        pass  # 静默

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    with socketserver.TCPServer(("", port), NoCacheHandler) as httpd:
        httpd.serve_forever()
