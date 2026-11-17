import { vi } from 'vitest'
import { compress } from '.'
import { stream, streamSSE } from '../../helper/streaming'
import { Hono } from '../../hono'

describe('Compress Middleware', () => {
  const app = new Hono()

  // Apply compress middleware to all routes
  app.use('*', compress())

  // Test routes
  app.get('/small', (c) => {
    c.header('Content-Type', 'text/plain')
    c.header('Content-Length', '5')
    return c.text('small')
  })
  app.get('/large', (c) => {
    c.header('Content-Type', 'text/plain')
    c.header('Content-Length', '1024')
    return c.text('a'.repeat(1024))
  })
  app.get('/small-json', (c) => {
    c.header('Content-Type', 'application/json')
    c.header('Content-Length', '26')
    return c.json({ message: 'Hello, World!' })
  })
  app.get('/large-json', (c) => {
    c.header('Content-Type', 'application/json')
    c.header('Content-Length', '1024')
    return c.json({ data: 'a'.repeat(1024), message: 'Large JSON' })
  })
  app.get('/no-transform', (c) => {
    c.header('Content-Type', 'text/plain')
    c.header('Content-Length', '1024')
    c.header('Cache-Control', 'no-transform')
    return c.text('a'.repeat(1024))
  })
  app.get('/jpeg-image', (c) => {
    c.header('Content-Type', 'image/jpeg')
    c.header('Content-Length', '1024')
    return c.body(new Uint8Array(1024)) // Simulated JPEG data
  })
  app.get('/already-compressed', (c) => {
    c.header('Content-Type', 'application/octet-stream')
    c.header('Content-Encoding', 'br')
    c.header('Content-Length', '1024')
    return c.body(new Uint8Array(1024)) // Simulated compressed data
  })
  app.get('/transfer-encoding-deflate', (c) => {
    c.header('Content-Type', 'application/octet-stream')
    c.header('Transfer-Encoding', 'deflate')
    c.header('Content-Length', '1024')
    return c.body(new Uint8Array(1024)) // Simulated deflate data
  })
  app.get('/chunked', (c) => {
    c.header('Content-Type', 'application/octet-stream')
    c.header('Transfer-Encoding', 'chunked')
    c.header('Content-Length', '1024')
    return c.body(new Uint8Array(1024)) // Simulated chunked data
  })
  app.get('/partial', (c) => {
    c.header('Content-Type', 'text/plain')
    c.header('Content-Length', '1024')
    c.header('Content-Range', 'bytes 0-1023/2048')
    return c.body('a'.repeat(1024), 206)
  })
  app.get('/stream', (c) =>
    stream(c, async (stream) => {
      c.header('Content-Type', 'text/plain')
      // 60000 bytes
      for (let i = 0; i < 10000; i++) {
        await stream.write('chunk ')
      }
    })
  )
  app.get('/already-compressed-stream', (c) =>
    stream(c, async (stream) => {
      c.header('Content-Type', 'text/plain')
      c.header('Content-Encoding', 'br')
      // 60000 bytes
      for (let i = 0; i < 10000; i++) {
        await stream.write(new Uint8Array([0, 1, 2, 3, 4, 5])) // Simulated compressed data
      }
    })
  )
  app.get('/sse', (c) =>
    streamSSE(c, async (stream) => {
      for (let i = 0; i < 1000; i++) {
        await stream.writeSSE({ data: 'chunk' })
      }
    })
  )
  app.notFound((c) => c.text('Custom NotFound', 404))

  const testCompression = async (
    path: string,
    acceptEncoding: string,
    expectedEncoding: string | null
  ) => {
    const req = new Request(`http://localhost${path}`, {
      method: 'GET',
      headers: new Headers({ 'Accept-Encoding': acceptEncoding }),
    })
    const res = await app.request(req)
    expect(res.headers.get('Content-Encoding')).toBe(expectedEncoding)
    return res
  }

  describe('Compression Behavior', () => {
    it('should compress large responses with gzip', async () => {
      const res = await testCompression('/large', 'gzip', 'gzip')
      expect(res.headers.get('Content-Length')).toBeNull()
      expect((await res.arrayBuffer()).byteLength).toBeLessThan(1024)
    })

    it('should compress large responses with deflate', async () => {
      const res = await testCompression('/large', 'deflate', 'deflate')
      expect((await res.arrayBuffer()).byteLength).toBeLessThan(1024)
    })

    it('should prioritize gzip over deflate when both are accepted', async () => {
      await testCompression('/large', 'gzip, deflate', 'gzip')
    })

    it('should not compress small responses', async () => {
      const res = await testCompression('/small', 'gzip, deflate', null)
      expect(res.headers.get('Content-Length')).toBe('5')
    })

    it('should not compress when no Accept-Encoding is provided', async () => {
      await testCompression('/large', '', null)
    })

    it('should not compress images', async () => {
      const res = await testCompression('/jpeg-image', 'gzip', null)
      expect(res.headers.get('Content-Type')).toBe('image/jpeg')
      expect(res.headers.get('Content-Length')).toBe('1024')
    })

    it('should not compress already compressed responses', async () => {
      const res = await testCompression('/already-compressed', 'gzip', 'br')
      expect(res.headers.get('Content-Length')).toBe('1024')
    })

    it('should remove Content-Length when compressing', async () => {
      const res = await testCompression('/large', 'gzip', 'gzip')
      expect(res.headers.get('Content-Length')).toBeNull()
    })

    it('should not remove Content-Length when not compressing', async () => {
      const res = await testCompression('/jpeg-image', 'gzip', null)
      expect(res.headers.get('Content-Length')).toBeDefined()
    })

    it('should not compress transfer-encoding: deflate', async () => {
      const res = await testCompression('/transfer-encoding-deflate', 'gzip', null)
      expect(res.headers.get('Content-Length')).toBe('1024')
      expect(res.headers.get('Transfer-Encoding')).toBe('deflate')
    })

    it('should not compress transfer-encoding: chunked', async () => {
      const res = await testCompression('/chunked', 'gzip', null)
      expect(res.headers.get('Content-Length')).toBe('1024')
      expect(res.headers.get('Transfer-Encoding')).toBe('chunked')
    })

    it('should not compress 206 Partial Content responses', async () => {
      const res = await testCompression('/partial', 'gzip', null)
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Length')).toBe('1024')
      expect(res.headers.get('Content-Range')).toBe('bytes 0-1023/2048')
      expect(await res.text()).toBe('a'.repeat(1024))
    })
  })

  describe('JSON Handling', () => {
    it('should not compress small JSON responses', async () => {
      const res = await testCompression('/small-json', 'gzip', null)
      expect(res.headers.get('Content-Length')).toBe('26')
    })

    it('should compress large JSON responses', async () => {
      const res = await testCompression('/large-json', 'gzip', 'gzip')
      expect(res.headers.get('Content-Length')).toBeNull()
      const decompressed = await decompressResponse(res)
      const json = JSON.parse(decompressed)
      expect(json.data.length).toBe(1024)
      expect(json.message).toBe('Large JSON')
    })
  })

  describe('Streaming Responses', () => {
    it('should compress streaming responses written in multiple chunks', async () => {
      const res = await testCompression('/stream', 'gzip', 'gzip')
      const decompressed = await decompressResponse(res)
      expect(decompressed.length).toBe(60000)
    })

    it('should not compress already compressed streaming responses', async () => {
      const res = await testCompression('/already-compressed-stream', 'gzip', 'br')
      expect((await res.arrayBuffer()).byteLength).toBe(60000)
    })

    it('should not compress server-sent events', async () => {
      const res = await testCompression('/sse', 'gzip', null)
      expect((await res.arrayBuffer()).byteLength).toBe(13000)
    })
  })

  describe('ETag Handling', () => {
    const app = new Hono()
    app.use('*', compress())
    app.get('/strong-etag', (c) => {
      c.header('Content-Type', 'text/plain')
      c.header('Content-Length', '1024')
      c.header('ETag', '"strong-etag"')
      return c.text('a'.repeat(1024))
    })
    app.get('/weak-etag', (c) => {
      c.header('Content-Type', 'text/plain')
      c.header('Content-Length', '1024')
      c.header('ETag', 'W/"weak-etag"')
      return c.text('a'.repeat(1024))
    })
    app.get('/no-etag', (c) => {
      c.header('Content-Type', 'text/plain')
      c.header('Content-Length', '1024')
      return c.text('a'.repeat(1024))
    })

    it('should convert strong ETag to weak ETag when compressing', async () => {
      const res = await app.request('/strong-etag', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
      expect(res.headers.get('ETag')).toBe('W/"strong-etag"')
    })

    it('should keep strong ETag when not compressing', async () => {
      const res = await app.request('/strong-etag')
      expect(res.headers.get('Content-Encoding')).toBeNull()
      expect(res.headers.get('ETag')).toBe('"strong-etag"')
    })

    it('should not modify weak ETag when compressing', async () => {
      const res = await app.request('/weak-etag', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
      expect(res.headers.get('ETag')).toBe('W/"weak-etag"')
    })

    it('should not add ETag when none exists', async () => {
      const res = await app.request('/no-etag', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
      expect(res.headers.get('ETag')).toBeNull()
    })
  })

  describe('Vary Header', () => {
    const app = new Hono()
    app.use('*', compress())
    app.get('/no-vary', (c) => {
      c.header('Content-Type', 'text/plain')
      c.header('Content-Length', '1024')
      return c.text('a'.repeat(1024))
    })
    app.get('/existing-vary', (c) => {
      c.header('Content-Type', 'text/plain')
      c.header('Content-Length', '1024')
      c.header('Vary', 'Cookie')
      return c.text('a'.repeat(1024))
    })
    app.get('/already-accept-encoding', (c) => {
      c.header('Content-Type', 'text/plain')
      c.header('Content-Length', '1024')
      c.header('Vary', 'Accept-Encoding')
      return c.text('a'.repeat(1024))
    })
    app.get('/wildcard-vary', (c) => {
      c.header('Content-Type', 'text/plain')
      c.header('Content-Length', '1024')
      c.header('Vary', '*')
      return c.text('a'.repeat(1024))
    })
    app.get('/not-compressible', (c) => {
      c.header('Content-Type', 'image/png')
      c.header('Content-Length', '1024')
      return c.body('a'.repeat(1024))
    })

    it('should set Vary: Accept-Encoding when compressing', async () => {
      const res = await app.request('/no-vary', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
      expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    })

    it('should append Accept-Encoding to an existing Vary header', async () => {
      const res = await app.request('/existing-vary', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
      expect(res.headers.get('Vary')).toBe('Cookie, Accept-Encoding')
    })

    it('should not duplicate Accept-Encoding when Vary already lists it', async () => {
      const res = await app.request('/already-accept-encoding', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
      expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    })

    it('should leave Vary: * unchanged', async () => {
      const res = await app.request('/wildcard-vary', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
      expect(res.headers.get('Vary')).toBe('*')
    })

    it('should set Vary on an identity response when Accept-Encoding is absent', async () => {
      const res = await app.request('/no-vary')
      expect(res.headers.get('Content-Encoding')).toBeNull()
      expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    })

    it('should set Vary on an identity response when no offered encoding is accepted', async () => {
      const res = await app.request('/no-vary', {
        headers: { 'Accept-Encoding': 'br' },
      })
      expect(res.headers.get('Content-Encoding')).toBeNull()
      expect(res.headers.get('Vary')).toBe('Accept-Encoding')
    })

    it('should not add a Vary header when the response is not eligible for compression', async () => {
      const res = await app.request('/not-compressible', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBeNull()
      expect(res.headers.get('Vary')).toBeNull()
    })
  })

  describe('contentTypeFilter', () => {
    describe('RegExp', () => {
      const app = new Hono()
      app.use('*', compress({ contentTypeFilter: /^application\/json/, threshold: 0 }))
      app.get('/json', (c) => c.json({ data: 'a'.repeat(1024) }))
      app.get('/text', (c) => c.text('a'.repeat(1024)))

      it('should compress when Content-Type matches', async () => {
        const res = await app.request('/json', {
          headers: { 'Accept-Encoding': 'gzip' },
        })
        expect(res.headers.get('Content-Encoding')).toBe('gzip')
      })

      it('should not compress when Content-Type does not match', async () => {
        const res = await app.request('/text', {
          headers: { 'Accept-Encoding': 'gzip' },
        })
        expect(res.headers.get('Content-Encoding')).toBeNull()
      })
    })

    describe('function', () => {
      const app = new Hono()
      app.use('*', compress({ contentTypeFilter: (type) => type.includes('json'), threshold: 0 }))
      app.get('/json', (c) => c.json({ data: 'a'.repeat(1024) }))
      app.get('/text', (c) => c.text('a'.repeat(1024)))

      it('should compress when Content-Type matches', async () => {
        const res = await app.request('/json', {
          headers: { 'Accept-Encoding': 'gzip' },
        })
        expect(res.headers.get('Content-Encoding')).toBe('gzip')
      })

      it('should not compress when Content-Type does not match', async () => {
        const res = await app.request('/text', {
          headers: { 'Accept-Encoding': 'gzip' },
        })
        expect(res.headers.get('Content-Encoding')).toBeNull()
      })
    })
  })

  describe('HEAD Content-Length', () => {
    it.each(['gzip', 'deflate'] as const)(
      'should omit the uncompressed length when GET uses %s',
      async (encoding) => {
        const headers = { 'Accept-Encoding': encoding }
        const get = await app.request('/large', { headers })
        expect(get.headers.get('Content-Encoding')).toBe(encoding)
        await get.arrayBuffer()

        const head = await app.request('/large', { method: 'HEAD', headers })
        expect(head.status).toBe(200)
        expect(head.headers.get('Content-Length')).toBeNull()
        expect(head.headers.get('Content-Encoding')).toBeNull()
        expect(head.body).toBeNull()
      }
    )

    it.each([
      ['absent encoding', undefined],
      ['unsupported encoding', 'br'],
      ['rejected encoding', 'gzip;q=0'],
    ] as const)('should preserve the length for %s', async (_name, acceptEncoding) => {
      const head = await app.request('/large', {
        method: 'HEAD',
        headers: acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : undefined,
      })
      expect(head.status).toBe(200)
      expect(head.headers.get('Content-Length')).toBe('1024')
      expect(head.body).toBeNull()
    })

    it('should preserve the length for Cache-Control: no-transform', async () => {
      const head = await app.request('/no-transform', {
        method: 'HEAD',
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(head.headers.get('Content-Length')).toBe('1024')
      expect(head.body).toBeNull()
    })

    it.each([
      ['/jpeg-image', '1024'],
      ['/partial', '1024'],
      ['/small', '5'],
    ])('should preserve the length of the excluded response %s', async (path, length) => {
      const head = await app.request(path, {
        method: 'HEAD',
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(head.headers.get('Content-Length')).toBe(length)
      expect(head.body).toBeNull()
    })

    it('should respect a configured compression threshold', async () => {
      const app = new Hono()
      app.use(compress({ threshold: 2048 }))
      app.get('/', (c) => c.text('a'.repeat(1024), 200, { 'Content-Length': '1024' }))

      const headers = { 'Accept-Encoding': 'gzip' }
      const get = await app.request('/', { headers })
      expect(get.headers.get('Content-Encoding')).toBeNull()
      expect(await get.text()).toBe('a'.repeat(1024))
      const head = await app.request('/', { method: 'HEAD', headers })
      expect(head.headers.get('Content-Length')).toBe('1024')
    })

    it('should preserve the encoded length of an already-compressed response', async () => {
      const headers = { 'Accept-Encoding': 'gzip' }
      const get = await app.request('/large', { headers })
      expect(get.headers.get('Content-Encoding')).toBe('gzip')
      const encoded = await get.arrayBuffer()
      const encodedApp = new Hono()
      encodedApp.use(compress({ threshold: 0 }))
      encodedApp.get('/', (c) =>
        c.body(encoded, 200, {
          'Content-Type': 'text/plain',
          'Content-Encoding': 'gzip',
          'Content-Length': String(encoded.byteLength),
        })
      )

      const head = await encodedApp.request('/', { method: 'HEAD', headers })
      expect(head.headers.get('Content-Encoding')).toBe('gzip')
      expect(head.headers.get('Content-Length')).toBe(String(encoded.byteLength))
      expect(head.body).toBeNull()
    })

    it('should omit the length of a null-body HEAD when GET would be compressed', async () => {
      const app = new Hono()
      app.use(compress())
      app.get('/', (c) => {
        const headers = {
          'Content-Type': 'text/plain',
          'Content-Length': '1024',
        }
        return c.req.method === 'HEAD'
          ? c.body(null, 200, headers)
          : c.body('a'.repeat(1024), 200, headers)
      })

      const headers = { 'Accept-Encoding': 'gzip' }
      const get = await app.request('/', { headers })
      expect(get.headers.get('Content-Encoding')).toBe('gzip')
      await get.arrayBuffer()
      const head = await app.request('/', { method: 'HEAD', headers })
      expect(head.headers.get('Content-Length')).toBeNull()
      expect(head.headers.get('Content-Encoding')).toBeNull()
      expect(head.body).toBeNull()
    })

    it.each([205, 304] as const)(
      'should preserve the length of a bodyless %s response',
      async (status) => {
        const length = status === 304 ? '1024' : '0'
        const app = new Hono()
        app.use(compress({ threshold: 0 }))
        app.get('/', (c) =>
          c.body(null, status, { 'Content-Type': 'text/plain', 'Content-Length': length })
        )

        const headers = { 'Accept-Encoding': 'gzip' }
        const get = await app.request('/', { headers })
        expect(get.headers.get('Content-Encoding')).toBeNull()
        expect(get.body).toBeNull()
        const head = await app.request('/', { method: 'HEAD', headers })
        expect(head.headers.get('Content-Length')).toBe(length)
        expect(head.body).toBeNull()
      }
    )

    it.each([false, true])(
      'should preserve headers without reading a locked=%s body',
      async (locked) => {
        const pull = vi.fn((controller: ReadableStreamDefaultController) => {
          controller.enqueue(new TextEncoder().encode('a'.repeat(1024)))
          controller.close()
        })
        const response = new Response(new ReadableStream({ pull }, { highWaterMark: 0 }), {
          headers: { 'Content-Type': 'text/plain', 'Content-Length': '1024', Vary: 'Origin' },
        })
        const cookies = [
          'session=abc; Path=/',
          'prefs=compact; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        ]
        for (const cookie of cookies) {
          response.headers.append('Set-Cookie', cookie)
        }
        const reader = locked ? response.body!.getReader() : undefined
        const app = new Hono()
        app.use(compress())
        app.get('/', () => response)

        try {
          const head = await app.request('/', {
            method: 'HEAD',
            headers: { 'Accept-Encoding': 'gzip' },
          })
          expect(head.status).toBe(200)
          expect(head.headers.get('Content-Length')).toBeNull()
          expect(head.headers.get('Vary')).toBe('Origin')
          expect(head.headers.getSetCookie()).toEqual(cookies)
          expect(head.body).toBeNull()
          expect(pull).not.toHaveBeenCalled()
          expect(response.body!.locked).toBe(locked)
        } finally {
          reader?.releaseLock()
          await response.body?.cancel()
        }
      }
    )

    it.each(['unread', 'locked', 'consumed'] as const)(
      'should handle an immutable fetch response with a %s body',
      async (state) => {
        const url = URL.createObjectURL(new Blob(['a'.repeat(1024)], { type: 'text/plain' }))
        const response = await fetch(url).finally(() => URL.revokeObjectURL(url))
        const reader = state === 'locked' ? response.body!.getReader() : undefined
        if (state === 'consumed') {
          await response.text()
        }
        const bodyUsed = response.bodyUsed
        const bodyLocked = response.body!.locked
        expect(() => response.headers.delete('Content-Length')).toThrow(TypeError)
        const app = new Hono()
        app.use(compress())
        app.get('/', () => response)

        try {
          const head = await app.request('/', {
            method: 'HEAD',
            headers: { 'Accept-Encoding': 'gzip' },
          })
          expect(head.status).toBe(200)
          expect(head.headers.get('Content-Length')).toBeNull()
          expect(head.headers.get('Content-Type')).toBe('text/plain')
          expect(head.body).toBeNull()
          expect(response.headers.get('Content-Length')).toBe('1024')
          expect(response.bodyUsed).toBe(bodyUsed)
          expect(response.body!.locked).toBe(bodyLocked)
        } finally {
          reader?.releaseLock()
          if (!response.bodyUsed) {
            await response.body?.cancel()
          }
        }
      }
    )

    it.each([
      { name: 'regular expression', contentTypeFilter: /^application\/x-hono$/ },
      { name: 'callback', contentTypeFilter: (type: string) => type === 'application/x-hono' },
    ])('should respect a custom $name content-type filter', async ({ contentTypeFilter }) => {
      const app = new Hono()
      app.use(compress({ contentTypeFilter }))
      app.get('/:type', (c) =>
        c.body('a'.repeat(1024), 200, {
          'Content-Type': c.req.param('type') === 'match' ? 'application/x-hono' : 'text/plain',
          'Content-Length': '1024',
        })
      )

      for (const path of ['/match', '/other']) {
        const headers = { 'Accept-Encoding': 'gzip' }
        const get = await app.request(path, { headers })
        expect(get.headers.get('Content-Encoding')).toBe(path === '/match' ? 'gzip' : null)
        await get.arrayBuffer()
        const head = await app.request(path, { method: 'HEAD', headers })
        expect(head.headers.get('Content-Length')).toBe(path === '/match' ? null : '1024')
      }
    })

    it.each(['gzip', 'deflate'] as const)(
      'should preserve the length when the configured %s encoding is not accepted',
      async (encoding) => {
        const app = new Hono()
        app.use(compress({ encoding }))
        app.get('/', (c) => c.text('a'.repeat(1024), 200, { 'Content-Length': '1024' }))

        const head = await app.request('/', {
          method: 'HEAD',
          headers: { 'Accept-Encoding': encoding === 'gzip' ? 'deflate' : 'gzip' },
        })
        expect(head.headers.get('Content-Length')).toBe('1024')
      }
    )
  })

  describe('Edge Cases', () => {
    it('should not compress responses with Cache-Control: no-transform', async () => {
      await testCompression('/no-transform', 'gzip', null)
    })

    it('should not set Content-Encoding on HEAD requests', async () => {
      const req = new Request('http://localhost/large', {
        method: 'HEAD',
        headers: new Headers({ 'Accept-Encoding': 'gzip' }),
      })
      const res = await app.request(req)
      expect(res.headers.get('Content-Encoding')).toBeNull()
      expect(res.headers.get('Content-Length')).toBeNull()
    })

    it('should compress custom 404 Not Found responses', async () => {
      const res = await testCompression('/not-found', 'gzip', 'gzip')
      expect(res.status).toBe(404)
      const decompressed = await decompressResponse(res)
      expect(decompressed).toBe('Custom NotFound')
    })
  })

  describe('Encoding Option', () => {
    const buildApp = (encoding: 'gzip' | 'deflate') => {
      const app = new Hono()
      app.use('*', compress({ encoding }))
      app.get('/large', (c) => {
        c.header('Content-Type', 'text/plain')
        c.header('Content-Length', '1024')
        return c.text('a'.repeat(1024))
      })
      return app
    }

    it('should compress when configured encoding is accepted by the client', async () => {
      const app = buildApp('gzip')
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
    })

    it('should not compress when configured encoding is not in Accept-Encoding', async () => {
      const app = buildApp('gzip')
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': 'deflate' },
      })
      expect(res.headers.get('Content-Encoding')).toBeNull()
    })

    it('should not compress when Accept-Encoding header is absent', async () => {
      const app = buildApp('gzip')
      const res = await app.request('/large')
      expect(res.headers.get('Content-Encoding')).toBeNull()
    })
  })

  describe('Accept-Encoding parsing', () => {
    const buildAppDefault = () => {
      const app = new Hono()
      app.use('*', compress())
      app.get('/large', (c) => {
        c.header('Content-Type', 'text/plain')
        c.header('Content-Length', '1024')
        return c.text('a'.repeat(1024))
      })
      return app
    }

    const buildAppWithEncoding = (encoding: 'gzip' | 'deflate') => {
      const app = new Hono()
      app.use('*', compress({ encoding }))
      app.get('/large', (c) => {
        c.header('Content-Type', 'text/plain')
        c.header('Content-Length', '1024')
        return c.text('a'.repeat(1024))
      })
      return app
    }

    it('should not compress when configured encoding has q=0', async () => {
      const app = buildAppWithEncoding('gzip')
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': 'gzip;q=0' },
      })
      expect(res.headers.get('Content-Encoding')).toBeNull()
    })

    it('should fall back to another encoding when the preferred one has q=0', async () => {
      const app = buildAppDefault()
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': 'gzip;q=0, deflate' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('deflate')
    })

    it('should compress when Accept-Encoding is the wildcard *', async () => {
      const app = buildAppWithEncoding('gzip')
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': '*' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
    })

    it('should compress when Accept-Encoding token differs only in case', async () => {
      const app = buildAppWithEncoding('gzip')
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': 'GZIP' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
    })

    it('should not treat x-gzip as gzip', async () => {
      const app = buildAppWithEncoding('gzip')
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': 'x-gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBeNull()
    })

    it('should pick the encoding with the highest q value', async () => {
      const app = buildAppDefault()
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': 'gzip;q=0.5, deflate;q=0.9' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('deflate')
    })

    it('should prefer gzip over deflate when q values are equal', async () => {
      const app = buildAppDefault()
      const res = await app.request('/large', {
        headers: { 'Accept-Encoding': 'gzip;q=0.5, deflate;q=0.5' },
      })
      expect(res.headers.get('Content-Encoding')).toBe('gzip')
    })
  })
})

async function decompressResponse(res: Response): Promise<string> {
  const decompressedStream = res.body!.pipeThrough(new DecompressionStream('gzip'))
  const decompressedResponse = new Response(decompressedStream)
  return await decompressedResponse.text()
}
