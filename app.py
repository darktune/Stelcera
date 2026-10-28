import os
import mimetypes

mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('image/svg+xml', '.svg')

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

def get_file_payload(path_info):
    raw_path = path_info or '/'
    clean_path = raw_path.lstrip('/')
    if not clean_path or clean_path == '/':
        target = 'index.html'
    else:
        target = clean_path

    full_path = os.path.join(ROOT_DIR, target)
    if not os.path.isfile(full_path):
        full_path = os.path.join(ROOT_DIR, 'index.html')

    if os.path.isfile(full_path):
        mime, _ = mimetypes.guess_type(full_path)
        mime = mime or 'application/octet-stream'
        with open(full_path, 'rb') as f:
            data = f.read()
        return 200, mime, data

    return 404, 'text/plain', b'Not Found'

async def asgi_app(scope, receive, send):
    if scope.get('type') != 'http':
        return
    status, mime, data = get_file_payload(scope.get('path', '/'))
    await send({
        'type': 'http.response.start',
        'status': status,
        'headers': [
            [b'content-type', mime.encode('utf-8')],
            [b'content-length', str(len(data)).encode('utf-8')],
            [b'cache-control', b'public, max-age=3600']
        ]
    })
    await send({
        'type': 'http.response.body',
        'body': data
    })

def wsgi_app(environ, start_response):
    status, mime, data = get_file_payload(environ.get('PATH_INFO', '/'))
    status_str = '200 OK' if status == 200 else '404 Not Found'
    start_response(status_str, [
        ('Content-Type', mime),
        ('Content-Length', str(len(data))),
        ('Cache-Control', 'public, max-age=3600')
    ])
    return [data]

class DualApp:
    def __call__(self, *args, **kwargs):
        if len(args) == 3 and isinstance(args[0], dict) and 'type' in args[0]:
            return asgi_app(*args, **kwargs)
        elif len(args) >= 2:
            return wsgi_app(*args, **kwargs)
        raise TypeError("Unsupported application signature")

app = DualApp()
