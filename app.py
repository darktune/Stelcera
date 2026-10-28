import os
import mimetypes

mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('image/svg+xml', '.svg')

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

def app(environ, start_response):
    raw_path = environ.get('PATH_INFO', '/') or '/'
    clean_path = raw_path.lstrip('/')
    if not clean_path or clean_path == '/':
        target_file = 'index.html'
    else:
        target_file = clean_path

    full_path = os.path.join(ROOT_DIR, target_file)
    if os.path.isfile(full_path):
        mime, _ = mimetypes.guess_type(full_path)
        mime = mime or 'application/octet-stream'
        with open(full_path, 'rb') as f:
            data = f.read()
        start_response('200 OK', [
            ('Content-Type', mime),
            ('Content-Length', str(len(data))),
            ('Cache-Control', 'public, max-age=3600')
        ])
        return [data]

    fallback_path = os.path.join(ROOT_DIR, 'index.html')
    if os.path.isfile(fallback_path):
        with open(fallback_path, 'rb') as f:
            data = f.read()
        start_response('200 OK', [
            ('Content-Type', 'text/html; charset=utf-8'),
            ('Content-Length', str(len(data)))
        ])
        return [data]

    start_response('404 Not Found', [('Content-Type', 'text/plain')])
    return [b'404 Not Found']
