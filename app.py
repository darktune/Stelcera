import os
import mimetypes

mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('image/svg+xml', '.svg')

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

async def app(scope, receive, send):
    if scope.get('type') == 'lifespan':
        while True:
            message = await receive()
            if message.get('type') == 'lifespan.startup':
                await send({'type': 'lifespan.startup.complete'})
            elif message.get('type') == 'lifespan.shutdown':
                await send({'type': 'lifespan.shutdown.complete'})
                return

    if scope.get('type') != 'http':
        return

    path = scope.get('path', '/') or '/'
    clean = path.lstrip('/')
    target = 'index.html' if not clean or clean == '/' else clean
    full = os.path.join(ROOT_DIR, target)
    if not os.path.isfile(full):
        full = os.path.join(ROOT_DIR, 'index.html')

    mime, _ = mimetypes.guess_type(full)
    mime = mime or 'text/html'

    try:
        with open(full, 'rb') as f:
            data = f.read()
        status = 200
    except Exception as e:
        data = f"File load error: {str(e)}".encode('utf-8')
        mime = 'text/plain'
        status = 500

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
